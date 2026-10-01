/**
 * The weather panel's own weather — 2026-08-19.
 *
 * The owner asked for the wall to *show* the day rather than only state it: rain falling when it
 * is raining, a sun when it is clear. This draws that, behind the reading, and it is built around
 * one rule taken from the ambient-life work that came before it.
 *
 * ## The rule
 *
 * > **The scene may say what the reading already says. It may never say anything else.**
 *
 * Every frame here is driven by the WMO code the district's own provider sent. There is no
 * animation that runs on a timer of its own, nothing that fades in on arrival, and nothing that
 * carries a value. If the code is unknown the panel draws **nothing** rather than a guess —
 * `describeCode` already refuses to guess a condition from an unmapped number (`ops/weather.ts`),
 * and a picture is a worse place to start guessing than a word.
 *
 * ## Why a canvas rather than CSS
 *
 * Rain is a few dozen moving objects. In CSS that is a few dozen elements inside a panel the
 * dashboard repaints every twenty seconds, and `signatureOf` compares rendered markup — so a
 * scene built from elements would either have to live outside the reconciled node or make the
 * whole panel differ from its own rebuild on every poll. One canvas is one element, it is a
 * **sibling** of `#dashWeather` rather than a child, and `clear()` never reaches it.
 *
 * It is also the cheaper half: one composited bitmap against forty blurred boxes, on a laptop
 * that is already driving a television.
 *
 * ## What it costs the wall, and the guards that bound it
 *
 * This runs twenty-four hours a day on a kiosk. So: particle counts are **capped**, the loop
 * stops dead when the tab is hidden or the dashboard is closed, the backing store is capped at
 * 2× device pixels, and **`prefers-reduced-motion` draws one still frame and starts no loop at
 * all** — the information survives, the motion does not, which is what that setting asks for.
 *
 * ## Why everything is so faint
 *
 * The ground under this is white (the district's own requirement) and the temperature sits on
 * top of it at `--t9`. Every alpha here was chosen to be visible as *weather* and invisible as
 * *contrast* — the panel's own words must never be harder to read at four metres because it
 * happens to be raining.
 */

/** The kinds of weather this draws. Anything not on this list is drawn as nothing. */
export type SceneKind = 'clear' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

export interface Sky {
  readonly kind: SceneKind;
  /** 0…1 — how hard. Drizzle and violent showers are the same scene at two strengths. */
  readonly strength: number;
  readonly night: boolean;
}

/**
 * WMO code → what to draw, and it is deliberately the same grouping `CONDITIONS` uses.
 *
 * The words on the panel and the picture behind them come from one number, so they cannot
 * describe two different days. A code this does not know returns **null**, and null draws
 * nothing: the panel then reads exactly as it did before this file existed.
 */
export function sceneFor(code: number | null): { kind: SceneKind; strength: number } | null {
  if (code === null) return null;

  switch (code) {
    case 0:
      return { kind: 'clear', strength: 1 };
    case 1:
      return { kind: 'clear', strength: 0.6 };
    case 2:
      return { kind: 'cloud', strength: 0.5 };
    case 3:
      return { kind: 'cloud', strength: 1 };
    case 45:
      return { kind: 'fog', strength: 0.7 };
    case 48:
      return { kind: 'fog', strength: 1 };
    case 51:
      return { kind: 'rain', strength: 0.25 };
    case 53:
      return { kind: 'rain', strength: 0.4 };
    case 55:
      return { kind: 'rain', strength: 0.55 };
    case 61:
    case 80:
      return { kind: 'rain', strength: 0.5 };
    case 63:
    case 81:
      return { kind: 'rain', strength: 0.75 };
    case 65:
    case 82:
      return { kind: 'rain', strength: 1 };
    case 71:
      return { kind: 'snow', strength: 0.4 };
    case 73:
      return { kind: 'snow', strength: 0.7 };
    case 75:
      return { kind: 'snow', strength: 1 };
    case 95:
      return { kind: 'storm', strength: 0.7 };
    case 96:
    case 99:
      return { kind: 'storm', strength: 1 };
    default:
      return null;
  }
}

/** Minutes past midnight for an `HH:MM` inside an ISO-ish local time, or null. */
function minutesOfDay(at: string | null): number | null {
  if (at === null || at.length < 16) return null;

  const hours = Number(at.slice(11, 13));
  const minutes = Number(at.slice(14, 16));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  return hours * 60 + minutes;
}

/**
 * Is it dark, according to the sunrise and sunset the panel is already showing?
 *
 * **Compared as wall-clock minutes, not as instants.** Open-Meteo is asked for `Asia/Karachi`
 * and returns local times without an offset; the screen this draws on is in Bajaur. Parsing those
 * strings as instants would have the browser read them in *its own* zone, which is the two
 * midnights defect this project has already paid for four times — so the comparison is done in
 * the one unit both sides genuinely agree on.
 *
 * Missing either time answers **day**, because a bright panel that should have been dark is a
 * smaller error than a dark one at noon, and this decides nothing but a colour.
 */
export function isNight(sunrise: string | null, sunset: string | null, now = new Date()): boolean {
  const up = minutesOfDay(sunrise);
  const down = minutesOfDay(sunset);
  if (up === null || down === null) return false;

  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes < up || minutes >= down;
}

export interface WeatherScene {
  /** Draw this sky, or `null` to draw nothing at all. */
  show: (sky: Sky | null) => void;
  /** Stop the loop and release the canvas. Called when the dashboard closes. */
  stop: () => void;
}

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
  sway: number;
}

interface Cloud {
  x: number;
  y: number;
  r: number;
  speed: number;
}

/** Above this the panel is a screensaver rather than a background. */
const MAX_DROPS = 90;

/**
 * Mount a scene inside a host element.
 *
 * The host is expected to be a positioned, clipped box the panel already owns — this creates the
 * canvas, sizes it to whatever the host is, and never touches anything else. It does not read the
 * feed and it does not decide when to run; `dashboard.ts` does both.
 */
export function mountWeatherScene(host: HTMLElement, reduced = false): WeatherScene {
  const canvas = document.createElement('canvas');
  canvas.className = 'wxcanvas';
  host.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let sky: Sky | null = null;
  let frame: number | null = null;
  let w = 0;
  let h = 0;

  let drops: Drop[] = [];
  let clouds: Cloud[] = [];
  /** When the next flash is due, as a timestamp. Storms only. */
  let flashAt = 0;
  let flash = 0;

  function size(): void {
    const rect = host.getBoundingClientRect();
    // A hidden panel measures zero. Drawing into a zero-sized canvas throws nothing and paints
    // nothing, so the guard is here rather than at every call site.
    if (rect.width < 1 || rect.height < 1) return;

    // Capped at 2: a wall screen is watched from four metres and a third pixel buys nothing but
    // a bigger bitmap to composite twenty-four hours a day.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function seed(): void {
    // Read once into a const: `sky` is reassigned by `show`, so a closure below it holds no
    // narrowing at all and the snow branches would each be a fresh null check.
    const now = sky;

    if (now === null) {
      drops = [];
      clouds = [];
      return;
    }

    const falling = now.kind === 'rain' || now.kind === 'storm' || now.kind === 'snow';
    const count = falling ? Math.round(MAX_DROPS * now.strength) : 0;

    drops = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      len: now.kind === 'snow' ? 1.4 + Math.random() * 1.6 : 6 + Math.random() * 10,
      speed: now.kind === 'snow' ? 12 + Math.random() * 18 : 210 + Math.random() * 190,
      sway: Math.random() * Math.PI * 2,
    }));

    const cloudy = now.kind === 'cloud' || now.kind === 'rain' || now.kind === 'storm';
    clouds = cloudy
      ? Array.from({ length: 3 }, (_, i) => ({
          x: (w / 3) * i + Math.random() * 40,
          y: h * (0.12 + Math.random() * 0.22),
          r: h * (0.34 + Math.random() * 0.24),
          speed: 3 + Math.random() * 5,
        }))
      : [];
  }

  function paintSky(): void {
    if (ctx === null || sky === null) return;

    if (sky.kind === 'clear') return;

    if (sky.kind === 'fog') {
      const haze = ctx.createLinearGradient(0, 0, 0, h);
      haze.addColorStop(0, 'rgba(120, 132, 150, 0.10)');
      haze.addColorStop(0.5, `rgba(120, 132, 150, ${String(0.16 * sky.strength)})`);
      haze.addColorStop(1, 'rgba(120, 132, 150, 0.06)');
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Everything else sits under an overcast wash, heavier for a storm.
    const heavy = sky.kind === 'storm' ? 0.13 : 0.08;
    const wash = ctx.createLinearGradient(0, 0, 0, h);
    wash.addColorStop(0, `rgba(70, 84, 110, ${String(heavy * sky.strength)})`);
    wash.addColorStop(1, 'rgba(70, 84, 110, 0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * The sun, and why it is a **disc with rays** rather than the wash this file shipped with.
   *
   * The first version was a soft radial glow — warm amber at 0.2 alpha, over the card. On the
   * district's white ground that measured about four levels of 255, which is exactly the finding
   * the ambient-gloss work already paid for once: *a light-coloured wash on a light card is
   * invisible, and no amount of alpha fixes it without wrecking the text over it.* Photographed
   * at 1920×1080 it read as nothing at all — a clear day and a blank panel looked identical.
   *
   * A disc has an **edge**, so it reads at four metres at an alpha the words above it survive.
   * The rays turn, once a minute, and the whole thing breathes — which is the difference between
   * *the sun is out* and *this panel has stopped*.
   *
   * ⚠️ **Placed at 0.86w / 0.36h deliberately.** That is the one quiet rectangle on this panel:
   * left of it is the temperature, below it is the WIND column, and above it is the age. Moving
   * it up puts it behind "JUST NOW"; moving it left puts it behind a number.
   */
  function paintSun(now: number): void {
    if (ctx === null || sky === null || sky.kind !== 'clear') return;

    const x = w * 0.86;
    const y = h * 0.36;
    // Breathes by a twentieth, over six seconds. Enough to see, not enough to watch.
    const beat = 1 + Math.sin(now / 950) * 0.05;
    const r = h * 0.2 * beat;
    const tint = sky.night ? '118, 140, 196' : '243, 168, 46';
    const core = (sky.night ? 0.26 : 0.34) * sky.strength;

    // The rays first, so the disc sits on top of them and keeps a clean edge.
    if (!sky.night) {
      ctx.save();
      ctx.translate(x, y);
      // One turn a minute — slow enough that a room reads it as light rather than as motion.
      ctx.rotate((now / 60000) * Math.PI * 2);
      ctx.strokeStyle = `rgba(${tint}, ${String(0.16 * sky.strength)})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * r * 1.5, Math.sin(angle) * r * 1.5);
        ctx.lineTo(Math.cos(angle) * r * 2.2, Math.sin(angle) * r * 2.2);
        ctx.stroke();
      }
      ctx.restore();
    }

    const halo = ctx.createRadialGradient(x, y, r * 0.7, x, y, r * 2.4);
    halo.addColorStop(0, `rgba(${tint}, ${String(core * 0.55)})`);
    halo.addColorStop(1, `rgba(${tint}, 0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);

    ctx.fillStyle = `rgba(${tint}, ${String(core)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // A moon is a disc with a bite taken out of it, drawn by punching the card's own ground back
    // over one side. `destination-out` would clear the panel behind it as well.
    if (sky.night) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(x + r * 0.42, y - r * 0.3, r * 0.92, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /**
   * Stars, and they are the night's answer to the rays.
   *
   * Seeded from the index rather than from `Math.random` on every frame, so a star stays where it
   * is and only its brightness moves — a field that re-scatters sixty times a second is static
   * noise, which reads as a broken screen rather than as a clear night.
   */
  function paintStars(now: number): void {
    if (ctx === null || sky === null || sky.kind !== 'clear' || !sky.night) return;

    for (let i = 0; i < 16; i += 1) {
      const x = ((i * 97) % 100) / 100;
      const y = ((i * 61) % 70) / 100;
      const twinkle = 0.35 + Math.sin(now / 700 + i) * 0.3;
      ctx.fillStyle = `rgba(120, 142, 196, ${String(Math.max(0, twinkle) * 0.4 * sky.strength)})`;
      ctx.beginPath();
      ctx.arc(x * w, y * h, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function paintClouds(dt: number): void {
    if (ctx === null) return;

    for (const cloud of clouds) {
      cloud.x += cloud.speed * dt;
      // One radius past the edge before wrapping, so a cloud never pops into existence on screen.
      if (cloud.x - cloud.r > w) cloud.x = -cloud.r;

      const blob = ctx.createRadialGradient(cloud.x, cloud.y, 0, cloud.x, cloud.y, cloud.r);
      blob.addColorStop(0, 'rgba(96, 108, 132, 0.13)');
      blob.addColorStop(1, 'rgba(96, 108, 132, 0)');
      ctx.fillStyle = blob;
      ctx.fillRect(cloud.x - cloud.r, cloud.y - cloud.r, cloud.r * 2, cloud.r * 2);
    }
  }

  function paintDrops(dt: number): void {
    if (ctx === null || sky === null) return;

    const snow = sky.kind === 'snow';
    ctx.strokeStyle = 'rgba(64, 92, 148, 0.22)';
    ctx.fillStyle = 'rgba(110, 130, 170, 0.30)';
    ctx.lineWidth = 1;

    for (const drop of drops) {
      drop.y += drop.speed * dt;
      drop.sway += dt * (snow ? 1.6 : 0.4);
      drop.x += snow ? Math.sin(drop.sway) * 9 * dt : 14 * dt;

      if (drop.y > h) {
        drop.y = -drop.len;
        drop.x = Math.random() * w;
      }
      if (drop.x > w) drop.x = 0;

      if (snow) {
        ctx.beginPath();
        ctx.arc(drop.x, drop.y, drop.len, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(drop.x, drop.y);
        // Slanted with the drift, so the streaks and the wind agree.
        ctx.lineTo(drop.x - drop.len * 0.16, drop.y + drop.len);
        ctx.stroke();
      }
    }
  }

  /**
   * The flash, and why it is rationed.
   *
   * A storm that lit up every second would be a warning light on a wall whose warning lights all
   * mean something. Four to eleven seconds apart, one frame bright and a short decay — enough to
   * read as lightning from across a room, not often enough to pull an eye off an emergency.
   */
  function paintFlash(dt: number, now: number): void {
    if (ctx === null || sky === null || sky.kind !== 'storm') return;

    if (now >= flashAt) {
      flash = 1;
      flashAt = now + 4000 + Math.random() * 7000;
    }

    if (flash <= 0) return;
    flash = Math.max(0, flash - dt * 3.2);
    ctx.fillStyle = `rgba(255, 246, 214, ${String(flash * 0.3 * sky.strength)})`;
    ctx.fillRect(0, 0, w, h);
  }

  function draw(dt: number, now: number): void {
    if (ctx === null) return;
    ctx.clearRect(0, 0, w, h);
    if (sky === null) return;

    paintSky();
    paintStars(now);
    paintSun(now);
    paintClouds(dt);
    paintDrops(dt);
    paintFlash(dt, now);
  }

  let last = 0;

  function loop(now: number): void {
    // Clamped: a tab that was backgrounded for a minute would otherwise resume with a single
    // enormous step and teleport every drop to the bottom of the panel at once.
    const dt = last === 0 ? 0.016 : Math.min((now - last) / 1000, 0.05);
    last = now;

    draw(dt, now);
    frame = window.requestAnimationFrame(loop);
  }

  function halt(): void {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    last = 0;
  }

  function run(): void {
    halt();
    if (sky === null || ctx === null) return;

    size();
    seed();

    // Reduced motion gets the picture and not the movement: one frame, no loop, nothing to
    // cancel. `opacity: 0` was the other option and it throws away a fact the panel is stating.
    if (reduced || document.hidden) {
      draw(0, performance.now());
      return;
    }

    frame = window.requestAnimationFrame(loop);
  }

  const onVisibility = (): void => {
    // Nothing is drawn for a screen nobody is looking at, and it resumes on its own.
    if (document.hidden) halt();
    else run();
  };

  const onResize = (): void => {
    run();
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);

  return {
    show(next) {
      const same =
        sky !== null &&
        next !== null &&
        sky.kind === next.kind &&
        sky.night === next.night &&
        Math.abs(sky.strength - next.strength) < 0.01;

      sky = next;
      host.dataset['scene'] = next === null ? '' : next.kind;

      // A poll that returned the same weather must not reseed: every drop would jump to a new
      // position, which is a whole panel visibly restarting over no news at all — the failure
      // `reconcile` exists to prevent, arriving through a canvas.
      if (same && frame !== null) return;
      run();
    },
    stop() {
      halt();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      canvas.remove();
    },
  };
}
