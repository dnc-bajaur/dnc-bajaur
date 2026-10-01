/**
 * Reading somebody else's feed — M9-59.
 *
 * No network. The fetching is four lines and the **parsing** is the half that will break, because
 * it reads a page Google owns and can change without telling anybody.
 *
 * So these tests are mostly ugly feeds: CDATA, entities, markup inside a title, a missing title,
 * a date that is not a date. Every one of them is a shape a real feed has produced somewhere, and
 * the rule throughout is the same — **what cannot be understood is dropped, never guessed at.**
 */

import { describe, expect, it } from 'vitest';

import { HEADLINE_COUNT, NEWS_LANGS, newsUrl, readFeed, refreshNews } from '../news.js';

const item = (inner: string): string => `<item>${inner}</item>`;

const feed = (...items: string[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Google News</title>${items.join('')}</channel></rss>`;

describe('readFeed', () => {
  it('reads a plain item', () => {
    const out = readFeed(
      feed(
        item(
          '<title>Flood warning issued for Bajaur</title><pubDate>Wed, 13 Aug 2026 09:00:00 GMT</pubDate>',
        ),
      ),
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Flood warning issued for Bajaur');
    expect(out[0]?.publishedAt).toBe('2026-08-13T09:00:00.000Z');
  });

  it('unwraps CDATA, which is how most feeds actually write a title', () => {
    const out = readFeed(feed(item('<title><![CDATA[Rain expected across KP]]></title>')));
    expect(out[0]?.title).toBe('Rain expected across KP');
  });

  it('decodes &amp; last, so a doubly-escaped entity does not become markup', () => {
    /**
     * A feed writes a literal `&lt;` as `&amp;lt;`. Decoding `&amp;` first turns that into
     * `&lt;` and then into `<` — and a headline about a comparison starts looking like a tag.
     * The order is the whole test.
     */
    const out = readFeed(
      feed(item('<title>Cotton &amp;lt; wheat, and PM &amp; cabinet meet</title>')),
    );
    expect(out[0]?.title).toBe('Cotton &lt; wheat, and PM & cabinet meet');
  });

  it('strips markup that survived, rather than passing it on', () => {
    // The dashboard uses textContent, so this could not become markup on screen. Stripped here
    // anyway: a second reader of this data one day may not be so careful.
    const out = readFeed(feed(item('<title>Bridge <b>reopens</b> at Mamund</title>')));
    expect(out[0]?.title).toBe('Bridge reopens at Mamund');
  });

  it('splits the outlet off the end of the title, on the LAST separator', () => {
    // Google appends ` - Dawn`. A title may legitimately contain a dash, so only the last one
    // counts — otherwise "Karachi - Lahore motorway reopens - Dawn" loses half its headline.
    const out = readFeed(feed(item('<title>Karachi - Lahore motorway reopens - Dawn</title>')));
    expect(out[0]?.title).toBe('Karachi - Lahore motorway reopens');
    expect(out[0]?.outlet).toBe('Dawn');
  });

  it('drops an item with no title rather than showing a blank row', () => {
    const out = readFeed(
      feed(
        item('<pubDate>Wed, 13 Aug 2026 09:00:00 GMT</pubDate>'),
        item('<title>Real one</title>'),
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Real one');
  });

  it('turns an unreadable date into null, never into the words "Invalid Date"', () => {
    const out = readFeed(
      feed(item('<title>Something happened</title><pubDate>whenever</pubDate>')),
    );
    expect(out[0]?.publishedAt).toBeNull();
  });

  it('stops at the headline count a room can actually read', () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`<title>Story ${String(i)}</title>`));
    expect(readFeed(feed(...many))).toHaveLength(HEADLINE_COUNT);
  });

  it('returns nothing at all for a page that is not a feed', () => {
    // Google serving an error page, a captcha, or a redirect notice. Nothing is invented from it.
    expect(readFeed('<html><body>Sorry, something went wrong.</body></html>')).toEqual([]);
  });

  it('reads the link, because a reader has to be able to reach the story', () => {
    const out = readFeed(
      feed(
        item(
          '<title>Flood warning issued for Bajaur</title><link>https://www.dawn.com/news/1892345</link>',
        ),
      ),
    );

    expect(out[0]?.url).toBe('https://www.dawn.com/news/1892345');
  });

  it('refuses a scheme it will not send a reader to, and keeps the headline anyway', () => {
    /**
     * A feed is somebody else's document, and `javascript:` in an href is the oldest trick
     * there is. The row survives with no link: a headline that cannot be opened is still a
     * headline, and silently dropping it would thin the panel for a reason nobody could see.
     */
    const out = readFeed(
      feed(item('<title>Real headline</title><link>javascript:alert(1)</link>')),
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('Real headline');
    expect(out[0]?.url).toBeNull();
  });

  it('leaves url null when the feed gave nothing usable', () => {
    const out = readFeed(feed(item('<title>No link here</title><link>not a url</link>')));
    expect(out[0]?.url).toBeNull();
  });

  it('stamps the edition on every row rather than guessing it from the characters', () => {
    // An Urdu headline about PIA or NADRA is half Latin. The screen sets `dir` and the
    // typeface from this field, and guessing either wrong on a wall is worse than no row.
    const out = readFeed(feed(item('<title>باجوڑ میں بارش</title>')), 'ur');
    expect(out[0]?.lang).toBe('ur');
    expect(readFeed(feed(item('<title>Rain in Bajaur</title>')))[0]?.lang).toBe('en');
  });
});

describe('newsUrl', () => {
  it('asks for the Pakistan edition', () => {
    const url = newsUrl();
    expect(url).toContain('news.google.com/rss/search');
    expect(url).toContain('gl=PK');
    expect(url).toContain('ceid=PK%3Aen');
  });

  it('takes the district’s own query, so changing it is a setting and not a code change', () => {
    expect(newsUrl('Khyber Pakhtunkhwa')).toContain('q=Khyber+Pakhtunkhwa');
  });

  it('asks Google for Urdu when Urdu is what the panel wants', () => {
    // The panel rotates both. Asking the English edition twice would be a rotation of one.
    const url = newsUrl(undefined, 'ur');
    expect(url).toContain('hl=ur');
    expect(url).toContain('ceid=PK%3Aur');
    expect(url).toContain('gl=PK');
  });

  it('gives each edition its own default query, because the word is not the same word', () => {
    expect(newsUrl(undefined, 'ur')).toContain(encodeURIComponent('پاکستان'));
    expect(newsUrl(undefined, 'en')).toContain('q=Pakistan');
  });
});

describe('refreshNews — the failure paths, which are the point', () => {
  /** A pool that would throw if anything tried to use it. Nothing here should reach one. */
  const noPool = {
    query: () => {
      throw new Error('refreshNews wrote to the database on a failed fetch');
    },
  } as never;

  it('reports a provider error and writes nothing', async () => {
    const result = await refreshNews(noPool, {
      fetcher: async () => ({ ok: false, status: 429, text: async () => '' }),
    });

    // The previous headlines stay exactly where they are, ageing visibly. That is a true
    // statement; a blank panel says nothing about whether the district's line is down.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('429');
  });

  it('treats a feed with no readable headlines as a failure, not as an empty day', async () => {
    /**
     * The one outcome worse than a failed fetch: replacing a good old list with an empty new one
     * and **resetting its age**, so the screen shows nothing and claims it is current.
     */
    const result = await refreshNews(noPool, {
      fetcher: async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no readable headlines');
  });

  it('survives a fetch that throws — a timeout, a DNS failure, a district line down', async () => {
    const result = await refreshNews(noPool, {
      fetcher: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });

    // It must never be able to take the process down: it is the least important thing on the
    // wall and it depends on a machine nobody in Bajaur controls.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timeout');
  });
});

describe('refreshNews — two editions, and one of them can fail alone', () => {
  /** A pool that remembers what it was asked to write, so the payload can be read back. */
  const capturing = (): { pool: never; payloads: string[] } => {
    const payloads: string[] = [];
    const pool = {
      query: (_sql: string, params?: unknown[]) => {
        if (params !== undefined && typeof params[1] === 'string') payloads.push(params[1]);
        return Promise.resolve({ rows: [] });
      },
    } as never;

    return { pool, payloads };
  };

  const xml = (title: string): string =>
    `<rss><channel><item><title>${title}</title><link>https://www.dawn.com/news/1</link></item></channel></rss>`;

  it('asks for every edition and stores them in the order the panel says them', async () => {
    const asked: string[] = [];
    const { pool, payloads } = capturing();

    const result = await refreshNews(pool, {
      fetcher: (url) => {
        asked.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(xml(url.includes('hl=ur') ? 'urdu story' : 'english story')),
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(asked).toHaveLength(NEWS_LANGS.length);

    // Urdu first, English second — the rotation is this order and nothing else. A client-side
    // timer would be a second clock that can drift out of step with the panel's own paint.
    const stored = JSON.parse(payloads[0] ?? '[]') as { title: string; lang: string }[];
    expect(stored.map((h) => h.lang)).toEqual(['ur', 'en']);
    expect(stored[0]?.title).toBe('urdu story');
  });

  it('stores the edition that answered when the other one did not, and still says so', async () => {
    /**
     * The whole reason two editions are fetched separately. A timeout on one is not a lost
     * list for the other, and a panel that keeps reading is the point — but a district whose
     * Urdu edition has been failing for a week must be able to find that out from the log
     * rather than by noticing the panel looks thin.
     */
    const { pool, payloads } = capturing();

    const result = await refreshNews(pool, {
      fetcher: (url) =>
        url.includes('hl=ur')
          ? Promise.reject(new Error('The operation was aborted due to timeout'))
          : Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(xml('english')) }),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toContain('ur edition');
    expect(result.error).toContain('timeout');

    const stored = JSON.parse(payloads[0] ?? '[]') as { lang: string }[];
    expect(stored.map((h) => h.lang)).toEqual(['en']);
  });

  it('writes nothing when neither edition is readable', async () => {
    // Both down is the old failure path, unchanged: the previous list stays exactly where it
    // is, ageing visibly, which is a true statement about the district's line.
    const noPool = {
      query: () => {
        throw new Error('refreshNews wrote to the database with nothing to write');
      },
    } as never;

    const result = await refreshNews(noPool, {
      fetcher: () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });
});
