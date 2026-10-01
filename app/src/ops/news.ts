/**
 * Headlines from outside the district — M9-59.
 *
 * The owner asked for a Pakistan news panel beside the weather, *"jis se proper live feel aaye"*.
 * This is that, and it is built to be the least dangerous version of it.
 *
 * ## The one rule this file exists to hold
 *
 * **Nothing here is the district's own information, and the screen must never let it be read as
 * such.** A wall in a control room carries emergencies Bajaur is answerable for. A national
 * headline sitting in the same typeface, two panels away, is one glance from being remembered as
 * a district fact — and the district cannot correct a story it did not write.
 *
 * So: the source is named on the panel, every item carries its own published time, and the whole
 * panel carries its age. `domain/wall.ts`'s header is about exactly this failure — a green dot
 * from nine hours ago is worse than no dot — and a headline from yesterday presented as today is
 * the same mistake with a bigger blast radius.
 *
 * ## Why Google's RSS and not an API
 *
 * ADR-0007 refuses dependencies that are not earning their place, and every news API worth using
 * wants a key, a billing account and a vendor relationship the district does not have. Google
 * News publishes RSS for a query with no key at all, and RSS is a format this file can read in
 * forty lines without a parser dependency.
 *
 * **It is somebody else's page and it will break.** Not "might": a query URL that has worked for
 * years is still a URL somebody else owns. So every failure path here leaves the previous
 * headlines untouched and returns a reason, exactly as `weather.ts` does.
 *
 * ## Why the parsing is deliberately shallow
 *
 * A real XML parser would be a dependency; a clever regex would be a liability. What this does is
 * narrow and boring: find `<item>` blocks, pull three known tags out of each, unwrap CDATA,
 * decode the five XML entities, strip any tags that survived, and take the first few. Anything it
 * does not understand is dropped rather than guessed at.
 *
 * **Nothing here trusts the content.** The dashboard builds its DOM with `textContent`, so a
 * headline containing markup is text and not markup — but tags are stripped here as well, because
 * a second reader of this data one day may not be so careful.
 */

import type { Pool } from '../db/pool.js';

/** How many a room can read at four metres before the panel is a wall of text. */
export const HEADLINE_COUNT = 6;

/** Where they came from, said on the panel. Never omitted. */
export const NEWS_SOURCE = 'Google News';

/**
 * Which edition a headline came from — added 2026-08-19.
 *
 * Carried on every row rather than inferred from the characters, because a script test is a
 * guess and an Urdu headline about `PIA` or `NADRA` is half Latin. The screen needs to know
 * for certain: it sets `dir` and the typeface from this, and getting either wrong on a wall
 * is worse than not showing the row.
 */
export type NewsLang = 'ur' | 'en';

/**
 * The order the panel says them in, and it is Urdu first.
 *
 * The owner asked for both, rotating. Rotation here is not a timer and not a toggle — the
 * list is simply Urdu then English, and the ticker scrolling through it is the rotation. One
 * ordering decided in one place beats a second clock on the client, and a clock that can drift
 * out of step with the panel's own paint is the bug this avoids by not existing.
 */
export const NEWS_LANGS: readonly NewsLang[] = ['ur', 'en'];

export interface Headline {
  readonly title: string;
  /** When the story was published, as the feed stated it. Null when it did not. */
  readonly publishedAt: string | null;
  /** Which outlet, when the feed names one — `Dawn`, `Geo News`. */
  readonly outlet: string | null;
  /**
   * Where the story actually is — added 2026-08-19, when the owner asked for reading to be
   * possible. Null when the feed gave no usable address, and a row with none is still shown:
   * a headline that cannot be opened is a headline, and dropping it would quietly thin the
   * panel for a reason nobody could see.
   */
  readonly url: string | null;
  readonly lang: NewsLang;
}

export interface NewsPanel {
  readonly headlines: readonly Headline[];
  readonly source: string;
  /** When **this system** fetched them. Different from any story's own time. */
  readonly fetchedAt: string | null;
  readonly ageMinutes: number | null;
}

/**
 * The query, and why it is this one.
 *
 * `hl`/`gl`/`ceid` ask Google for the Pakistan edition. **Both editions are asked for now** —
 * this file used to argue for English alone, on the grounds that the rest of the product is in
 * English and a panel that mixes scripts at four metres is harder to scan. The owner overruled
 * it on 2026-08-19, wanting the panel to read like a news channel, and they are right about the
 * thing that matters: this is the one panel a room looks at because it *wants* to, and a room
 * that reads Urdu should be given Urdu.
 *
 * **The rest of the product stays English.** That is the owner's line, not a default I chose —
 * *"app ka baki langauge aur text etc english mai hi thek hai"*. Nothing outside this panel's
 * own rows changes script or typeface.
 *
 * Each edition keeps its own query, because the useful search term is not the same word in
 * both. `NEWS_QUERY` and `NEWS_QUERY_UR` override them, so a district that wants Bajaur instead
 * of Pakistan changes a setting rather than this file.
 */
const DEFAULT_QUERY: Readonly<Record<NewsLang, string>> = {
  en: 'Pakistan',
  ur: 'پاکستان',
};

export function newsUrl(query?: string, lang: NewsLang = 'en'): string {
  const configured = lang === 'ur' ? process.env['NEWS_QUERY_UR'] : process.env['NEWS_QUERY'];
  const params = new URLSearchParams({
    q: query ?? configured ?? DEFAULT_QUERY[lang],
    hl: lang === 'ur' ? 'ur' : 'en-PK',
    gl: 'PK',
    ceid: lang === 'ur' ? 'PK:ur' : 'PK:en',
  });

  return `https://news.google.com/rss/search?${params.toString()}`;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

/**
 * One tag's text, unwrapped and decoded — or null.
 *
 * `&amp;` is decoded **last**, after the others. Otherwise `&amp;lt;` — which is how a feed
 * writes a literal `&lt;` — becomes `<`, and a headline about a policy comparison turns into
 * something that looks like markup.
 */
function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (match === null) return null;

  let text = match[1] ?? '';
  text = text.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  // Any markup that survived — feeds do put anchors in a title. Stripped, never rendered.
  text = text.replace(/<[^>]*>/g, '');
  for (const [entity, char] of Object.entries(ENTITIES)) {
    if (entity !== '&amp;') text = text.split(entity).join(char);
  }
  text = text.split('&amp;').join('&');

  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A feed's `<link>`, if it is one this system is willing to send a reader to.
 *
 * **Only `http:` and `https:`.** A feed is somebody else's document and `javascript:` in an
 * `href` is the oldest trick there is — the dashboard builds its anchors with `textContent` and
 * a set `href`, so a scheme check here is what stands between a hostile feed and a click. It is
 * checked at the point the value enters the system rather than at the point it is rendered,
 * because there is one of the first and there will one day be several of the second.
 *
 * Anything unparseable is null, which the panel renders as an unclickable row rather than as a
 * broken link. A dead link on a wall is worse than no link: it teaches a room that the panel
 * does not work.
 */
function readLink(block: string): string | null {
  const raw = tagText(block, 'link');
  if (raw === null) return null;

  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Read a feed into headlines.
 *
 * Exported and pure, so the parsing can be tested against real feed shapes without a network —
 * which is the half of this that will actually break.
 */
export function readFeed(xml: string, lang: NewsLang = 'en', limit = HEADLINE_COUNT): Headline[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  const headlines: Headline[] = [];

  for (const item of items) {
    const title = tagText(item, 'title');
    // A headline with no headline is not a headline. Dropped rather than shown as blank.
    if (title === null) continue;

    /**
     * Google appends the outlet to the title as ` - Dawn`. Split it off so the panel can show
     * the outlet quietly beside the story instead of running it into the sentence — and only on
     * the **last** separator, because a title may legitimately contain a dash.
     */
    let clean = title;
    let outlet = tagText(item, 'source');
    const cut = title.lastIndexOf(' - ');
    if (outlet === null && cut > 20) {
      outlet = title.slice(cut + 3).trim();
      clean = title.slice(0, cut).trim();
    } else if (outlet !== null && title.endsWith(` - ${outlet}`)) {
      clean = title.slice(0, title.length - outlet.length - 3).trim();
    }

    const published = tagText(item, 'pubDate');
    const at = published === null ? null : new Date(published);

    headlines.push({
      title: clean,
      // Normalised to an instant here so nothing downstream has to parse RFC-822 by hand.
      // Unparseable becomes null rather than `Invalid Date`, which renders as the word.
      publishedAt: at === null || Number.isNaN(at.getTime()) ? null : at.toISOString(),
      outlet,
      url: readLink(item),
      lang,
    });

    if (headlines.length >= limit) break;
  }

  return headlines;
}

export interface NewsFetchResult {
  readonly ok: boolean;
  /**
   * What went wrong, when something did — **and `ok` can be true while this is set.**
   *
   * Two editions are fetched now, and one of them failing is neither a success worth silence
   * nor a failure worth discarding the other. So the refresh stores what it got and still says
   * what it lost, and `main.ts` logs on this field rather than on `ok`. A district whose Urdu
   * edition has been failing for a week should be able to find that out from the log without
   * anybody noticing the panel looks thin.
   */
  readonly error?: string;
}

export type TextFetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Fetch once and store it, or record that it could not be done.
 *
 * A failure leaves the previous headlines in place and untouched — the same design as
 * `refreshWeather`, for the same reason. The screen then shows the old list **with its real
 * age**, which is true, rather than a blank panel that says nothing about the district's line.
 *
 * A response that parsed to **zero** headlines is treated as a failure, deliberately. Storing it
 * would replace a good old list with an empty new one and reset its age, which is the one
 * outcome worse than a failed fetch.
 */
export async function refreshNews(
  pool: Pool,
  options: { fetcher?: TextFetcher; timeoutMs?: number; query?: string } = {},
): Promise<NewsFetchResult> {
  const fetcher: TextFetcher =
    options.fetcher ??
    ((url) =>
      fetch(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        // Named plainly. A district's server pretending to be a browser is a district's server
        // that gets blocked without ever being told why.
        headers: { 'user-agent': 'DistrictNerveCenter/1.0 (+https://dnc.example.com)' },
      }).then((r) => ({ ok: r.ok, status: r.status, text: () => r.text() })));

  /**
   * One edition, and it **cannot throw**.
   *
   * Each edition is caught on its own so that a timeout on one is not a lost list for the
   * other. The whole point of fetching two is that the panel keeps reading when one of them
   * stops answering, and a single `try` around both would have thrown that away on the first
   * DNS failure.
   */
  const edition = async (
    lang: NewsLang,
  ): Promise<{ headlines: Headline[]; error: string | null }> => {
    try {
      const response = await fetcher(newsUrl(options.query, lang));
      if (!response.ok) {
        return {
          headlines: [],
          error: `${lang} edition: provider replied ${String(response.status)}`,
        };
      }

      return { headlines: readFeed(await response.text(), lang), error: null };
    } catch (cause) {
      return {
        headlines: [],
        error: `${lang} edition: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  };

  // In `NEWS_LANGS` order, and sequentially rather than in parallel: this runs on a twenty
  // minute timer against somebody else's server, so two requests a third of a second apart is
  // politeness that costs the district nothing.
  const headlines: Headline[] = [];
  const errors: string[] = [];

  for (const lang of NEWS_LANGS) {
    const result = await edition(lang);
    headlines.push(...result.headlines);
    if (result.error !== null) errors.push(result.error);
  }

  /**
   * **Nothing readable at all is a failure**, and the previous headlines stay exactly where
   * they are, ageing visibly — the same rule this file has always followed, and the same one
   * `weather.ts` follows. Storing an empty list would replace a good old one with a blank new
   * one and reset its age, which is the one outcome worse than a failed fetch.
   */
  if (headlines.length === 0) {
    return { ok: false, error: errors[0] ?? 'feed carried no readable headlines' };
  }

  try {
    await pool.query('INSERT INTO news_fetch (source, payload) VALUES ($1, $2)', [
      NEWS_SOURCE,
      JSON.stringify(headlines),
    ]);
    await pool.query(
      `DELETE FROM news_fetch
        WHERE fetch_id NOT IN (SELECT fetch_id FROM news_fetch ORDER BY fetched_at DESC LIMIT 20)`,
    );
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  // Stored, and still honest about the half that did not arrive.
  return errors.length === 0 ? { ok: true } : { ok: true, error: errors.join('; ') };
}

/** What the screen is given: the headlines, and how old they are. Never one without the other. */
export async function newsPanel(pool: Pool, now = new Date()): Promise<NewsPanel> {
  const { rows } = await pool.query<{
    fetched_at: string;
    source: string;
    payload: Headline[];
  }>('SELECT fetched_at, source, payload FROM news_fetch ORDER BY fetched_at DESC LIMIT 1');

  const row = rows[0];
  if (row === undefined) {
    return { headlines: [], source: NEWS_SOURCE, fetchedAt: null, ageMinutes: null };
  }

  const fetched = new Date(row.fetched_at).getTime();

  return {
    headlines: row.payload,
    source: row.source,
    fetchedAt: row.fetched_at,
    ageMinutes: Number.isNaN(fetched)
      ? null
      : Math.max(0, Math.floor((now.getTime() - fetched) / 60_000)),
  };
}
