import { useEffect, useMemo, useState } from "react";

/* ---------------- color math ---------------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Tone value increase (dot gain), parabolic, peaking at 50%
const dotGain = (a, gain) => clamp(a + gain * 4 * a * (1 - a), 0, 1);

// Demo transform: CMYK (0..1) -> linear RGB via subtractive model + dot gain.
// Production: replace with real ICC profile (GRACoL / SWOP / press profile) via lcms-wasm.
function cmykToLinRgb([c, m, y, k], gain) {
  const c1 = dotGain(c, gain), m1 = dotGain(m, gain),
        y1 = dotGain(y, gain), k1 = dotGain(k, gain);
  return [(1 - c1) * (1 - k1), (1 - m1) * (1 - k1), (1 - y1) * (1 - k1)];
}

const WP = [0.95047, 1.0, 1.08883];
function linToXyz([r, g, b]) {
  return [
    0.4124 * r + 0.3576 * g + 0.1805 * b,
    0.2126 * r + 0.7152 * g + 0.0722 * b,
    0.0193 * r + 0.1192 * g + 0.9505 * b,
  ];
}
function xyzToLab([x, y, z]) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / WP[0]), fy = f(y / WP[1]), fz = f(z / WP[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
// 4-D multilinear interpolation through a profile LUT (grid^4 CMYK -> Lab points)
function lutLookup(lut, cmyk) {
  const g = lut.grid, n = g - 1;
  const pos = cmyk.map((v) => clamp(v, 0, 1) * n);
  const i0 = pos.map((p) => Math.min(Math.floor(p), n - 1));
  const f = pos.map((p, i) => p - i0[i]);
  const out = [0, 0, 0];
  for (let corner = 0; corner < 16; corner++) {
    let w = 1, idx = 0;
    for (let d = 0; d < 4; d++) {
      const up = (corner >> d) & 1;
      w *= up ? f[d] : 1 - f[d];
      idx = idx * g + i0[d] + up;
    }
    if (w === 0) continue;
    for (let ch = 0; ch < 3; ch++) out[ch] += w * lut.lab[idx * 3 + ch];
  }
  return out;
}

function labToXyz([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  return [fi(fx) * WP[0], fi(fy) * WP[1], fi(fz) * WP[2]];
}

// LUT Lab is media-relative; adapt it to the user's actual material white in XYZ,
// which never clips colors that sit outside screen gamut (press cyan does).
function cmykToLabLut(lut, cmyk, matLab) {
  const xyz = labToXyz(lutLookup(lut, cmyk));
  const mw = labToXyz(matLab);
  return xyzToLab([
    (xyz[0] * mw[0]) / WP[0],
    (xyz[1] * mw[1]) / WP[1],
    (xyz[2] * mw[2]) / WP[2],
  ]);
}

function cmykToLabGeneric(cmyk, gain, matLab) {
  const xyz = linToXyz(cmykToLinRgb(cmyk, gain)); // ink on perfect white
  const mw = labToXyz(matLab);
  return xyzToLab([
    (xyz[0] * mw[0]) / WP[0],
    (xyz[1] * mw[1]) / WP[1],
    (xyz[2] * mw[2]) / WP[2],
  ]);
}

const cmykToLab = (cmyk, gain, paper, lut, matLab) =>
  lut ? cmykToLabLut(lut, cmyk, matLab)
      : cmykToLabGeneric(cmyk, gain, matLab);

function labToLin([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = fi(fx) * WP[0], y = fi(fy) * WP[1], z = fi(fz) * WP[2];
  return [
    clamp(3.2406 * x - 1.5372 * y - 0.4986 * z, 0, 1),
    clamp(-0.9689 * x + 1.8758 * y + 0.0415 * z, 0, 1),
    clamp(0.0557 * x - 0.204 * y + 1.057 * z, 0, 1),
  ];
}
function labToCss(lab) {
  const gam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const [r, g, b] = labToLin(lab).map((v) => Math.round(gam(v) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

// Full CIEDE2000
function deltaE00([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) / rad + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const dh = h2p - h1p;
    dhp = Math.abs(dh) <= 180 ? dh : dh > 180 ? dh - 360 : dh + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    const dh = Math.abs(h1p - h2p);
    hbp = dh <= 180 ? (h1p + h2p) / 2
      : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt(
    (dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH)
  );
}

// Solve a 4x4 linear system by Gaussian elimination with partial pivoting
function solve4(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) continue;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let cc = col; cc < 5; cc++) M[r][cc] -= f * M[col][cc];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[4] / row[i]));
}

// Gauss–Newton with ridge damping: find the CMYK that lands on targetLab,
// starting from the current run. The probe step is the "how does each ink
// move the color from where I'm standing" part.
function solveCorrection(current, targetLab, gain, paper, lut, matLab, measuredLab) {
  let x = [...current];
  // If the press color was measured (not predicted), compute the offset between
  // what the model thinks this build makes and what was actually measured, and
  // carry it through the solve so corrections target the real sheet, not the model.
  const predicted = cmykToLab(current, gain, paper, lut, matLab);
  const offset = measuredLab
    ? [measuredLab[0] - predicted[0], measuredLab[1] - predicted[1], measuredLab[2] - predicted[2]]
    : [0, 0, 0];
  for (let iter = 0; iter < 12; iter++) {
    const raw = cmykToLab(x, gain, paper, lut, matLab);
    const base = [raw[0] + offset[0], raw[1] + offset[1], raw[2] + offset[2]];
    const r = [targetLab[0] - base[0], targetLab[1] - base[1], targetLab[2] - base[2]];
    if (Math.hypot(...r) < 0.05) break;
    const eps = 0.004;
    const J = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let ch = 0; ch < 4; ch++) {
      const xp = [...x];
      const step = xp[ch] + eps <= 1 ? eps : -eps;
      xp[ch] += step;
      const lp = cmykToLab(xp, gain, paper, lut, matLab);
      for (let i = 0; i < 3; i++) J[i][ch] = (lp[i] - base[i]) / step;
    }
    const lam = 0.02;
    const A = [], bv = [];
    for (let i = 0; i < 4; i++) {
      A.push([]);
      let s = 0;
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += J[k][i] * J[k][j];
        A[i].push(sum + (i === j ? lam : 0));
      }
      for (let k = 0; k < 3; k++) s += J[k][i] * r[k];
      bv.push(s);
    }
    const d = solve4(A, bv);
    x = x.map((v, i) => clamp(v + 0.7 * d[i], 0, 1));
  }
  return x;
}

/* ---------------- UI ---------------- */
const TIER = "free"; // "free" | "pro" | "shop" — set by the license key
const SHOP_NAME = ""; // shop-license name; shown on the badge and job tickets when TIER is "shop"
const isPro = TIER === "pro" || TIER === "shop"; // Pro features unlock for both paid tiers
const VERSION = "0.9.16"; // bumped with every release; shown in the footer
const CONTACT = "hello@drawdown.press"; // used by the footer pitch, About page, and card buy link
const PRO_URL = ""; // paste your checkout page URL here when it exists; empty scrolls to the pitch
const CARD_URL = "https://drawdownpress.lemonsqueezy.com"; // store front — card options live here

const PROFILES = [
  { id: "gracol-c", name: "GRACoL 2013 — Coated", gain: 0.14, tac: 320 },
  { id: "gracol-u", name: "GRACoL — Uncoated", gain: 0.22, tac: 280 },
  { id: "swop", name: "SWOP — Coated #3", gain: 0.17, tac: 300 },
];

const MATERIALS = [
  { name: "Bright coated", lab: [95, 1, -2] },
  { name: "Uncoated natural", lab: [93, 0, 4] },
  { name: "White vinyl", lab: [94, -1, -3] },
];

const CHANNELS = [
  { key: "C", name: "Cyan", color: "#009DDC", text: "#fff" },
  { key: "M", name: "Magenta", color: "#E5007E", text: "#fff" },
  { key: "Y", name: "Yellow", color: "#F0B800", text: "#000" },
  { key: "K", name: "Black", color: "#000000", text: "#fff" },
];

function Mark({ h = 38 }) {
  return (
    <svg
      viewBox="146 90 220 380" height={h} width={(220 / 380) * h}
      aria-hidden="true" className="logomark"
    >
      <path fill="#009DDC" d="M156 118 Q156 100 174 100 L256 100 L256 396 Q204 414 156 392 Z" />
      <path fill="#0A72B5" d="M256 100 L338 100 Q356 100 356 118 L356 402 Q344 462 312 448 Q288 438 256 404 Z" />
    </svg>
  );
}

function About() {
  return (
    <div className="about">
      <h2 className="abouthead">How to use Drawdown</h2>
      <p className="aboutp">
        Drawdown does one job: you tell it the color you're chasing and the color your machine is
        actually putting down, and it hands back ink moves — "C −3, M +5" — that close the gap.
        It thinks the way you do at the console, just with the math done.
      </p>

      <h3 className="abouth">Quick start</h3>
      <ol>
        <li>Pick your printing condition at the top right — coated or uncoated stock in the free version, a real press profile in Pro.</li>
        <li>In <strong>Target</strong>, enter the CMYK build you're chasing. In Pro you can switch to Lab and type numbers straight off a spectro or a chip's published values.</li>
        <li>In <strong>On press/printer</strong>, enter the build that's running right now.</li>
        <li>In <strong>Material</strong>, tell it what's under the ink: tap a preset, describe the stock's cast in CMYK, or (Pro) type the spectro reading of the unprinted material. Inks are transparent — the stock shifts every color on it, so this matters more than it looks.</li>
        <li>Read <strong>The correction</strong>, make the moves, run it, punch in the new numbers, repeat until it passes.</li>
      </ol>

      <h3 className="abouth">The patches and the number</h3>
      <p className="aboutp">
        The two swatches sit on your material like a drawdown card: target on the left, what's
        printing on the right. The big number is ΔE2000, the industry's measure of how far apart two
        colors look: under 1 is invisible, 1–2 passes most commercial work, 2–3.5 shows in a
        side-by-side, and beyond that the client calls.
      </p>

      <h3 className="abouth">The pass line <span className="propill">Pro</span></h3>
      <p className="aboutp">
        A match is only "good enough" against a standard, and the standard changes with the job.
        The pass-line chips under the ΔE number let you set that threshold — 1, 2, or 3.5 — and the
        verdict judges against it: a reading of 1.8 passes at ΔE 2 but fails at ΔE 1, and the words
        change to say so. Set it tight for a brand color or a hospital account, loose for a one-off
        flyer where close is fine and press time isn't. The pass line also feeds the reach warning —
        Drawdown flags a target as out of reach when it can't get you inside the tolerance you set,
        not some fixed number.
      </p>

      <h3 className="abouth">Measuring the material <span className="propill">Pro</span></h3>
      <p className="aboutp">
        In the free version you set the material by eye — a preset, or a light CMYK tint that
        describes the stock's cast. Pro unlocks the Lab fields so you can spectro the unprinted
        material and type the exact reading. That's the difference between guessing the stock is
        "warmish" and knowing it's L 92.4, a 1.1, b 4.8. Because inks are transparent filters over
        whatever's underneath, a real material reading tightens every prediction and every move the
        tool hands back — most visibly on off-white and colored stock, house sheets, and sign
        substrates like vinyl and banner, where the white is nothing like a printer's reference paper.
        Read the bare material once at the start of a run and the corrections that follow are working
        from what's actually on the press, not an assumption.
      </p>

      <h3 className="abouth">The correction</h3>
      <p className="aboutp">
        The moves are whole ink points, solved from where your build currently sits — moving cyan at
        90% does something different than at 30%, and the solver knows it. The predicted ΔE tells
        you whether the move is worth making. It will also warn you when a target sits outside what
        the condition can reach, and in Pro, when a corrected build would exceed the profile's total
        ink coverage limit and flood the sheet. Pro's "Copy for the job ticket" puts the whole
        correction on your clipboard for the job jacket.
      </p>

      <h3 className="abouth">The Gray Balance Card</h3>
      <p className="aboutp">
        There's a printed companion to the app: a pocket card, color-managed on press, that lives by
        the machine. One side carries a neutral step wedge and the CMYK gray-balance builds — hold it
        against a proof and your eye catches a cast faster than any number. The other side is the ΔE
        tolerance ladder and the total-ink limits for each profile, so the thresholds are in your hand
        when the app isn't. It's the physical version of what Drawdown does on screen. There's a link
        to order one at the bottom of the page.
      </p>

      <h3 className="abouth">Free and Pro</h3>
      <p className="aboutp">
        Free runs a generic press model and dials in by eye — genuinely useful, honestly ballpark.
        Pro runs real ICC press profiles, takes spectro Lab numbers for targets and materials, holds
        your tolerances, guards ink limits, and writes your paper trail. A shop license covers the
        whole crew under one subscription and stamps your shop's name on every job ticket.
      </p>
      <p className="aboutp">
        Pro is <strong>$8.99/month</strong> or <strong>$79/year</strong> — the annual plan works out
        to under $7 a month, about the cost of one avoided make-ready. The printed Gray Balance Card
        is sold separately, on its own or as a 3-pack, whether or not you subscribe. Questions,
        gripes, early access: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </div>
  );
}

function WarnIcon() {
  return (
    <svg className="warnicon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d="M12 3 L22 20 L2 20 Z" fill="none" stroke="#8A2B00" strokeWidth="2" strokeLinejoin="round" />
      <line x1="12" y1="9" x2="12" y2="14" stroke="#8A2B00" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.15" fill="#8A2B00" />
    </svg>
  );
}

function ChannelRow({ ch, value, onChange, max = 100, disabled = false }) {
  const c = CHANNELS[ch];
  return (
    <div className="chrow">
      <span className="chchip" style={{ background: c.color, color: c.text }}>{c.key}</span>
      <input
        type="range" min={0} max={max} step={1} value={value} disabled={disabled}
        style={{ accentColor: c.color }}
        aria-label={`${c.name} percent`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className="numin" type="number" min={0} max={max} value={value} disabled={disabled}
        aria-label={`${c.name} value`}
        onChange={(e) => onChange(clamp(Number(e.target.value) || 0, 0, max))}
      />
    </div>
  );
}

export default function Drawdown() {
  const [stock, setStock] = useState("coated");
  const [profileId, setProfileId] = useState("gracol-c");
  const [luts, setLuts] = useState({});

  useEffect(() => {
    if (!isPro) return;
    PROFILES.forEach((p) => {
      fetch(`/luts/${p.id}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((lut) => {
          if (lut && lut.grid && lut.lab) setLuts((prev) => ({ ...prev, [p.id]: lut }));
        })
        .catch(() => {});
    });
  }, []);
  const [targetMode, setTargetMode] = useState("cmyk");
  const [targetCmyk, setTargetCmyk] = useState([100, 55, 0, 18]);
  const [targetLabIn, setTargetLabIn] = useState([28, 18, -58]);
  const [current, setCurrent] = useState([90, 45, 8, 15]);
  const [pressMode, setPressMode] = useState("cmyk");
  const [pressLabIn, setPressLabIn] = useState([44, 46, -49]);
  const [material, setMaterial] = useState([95, 1, -2]);
  const [matMode, setMatMode] = useState("lab");
  const [matCmyk, setMatCmyk] = useState([0, 0, 4, 2]);
  const [tol, setTol] = useState(2);
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState("app");

  const gain = isPro
    ? PROFILES.find((p) => p.id === profileId).gain
    : stock === "coated" ? 0.14 : 0.22;
  const activeLut = isPro ? luts[profileId] : undefined;

  const materialLab = useMemo(
    () => (matMode === "cmyk" ? cmykToLab(matCmyk.map((v) => v / 100), 0, null, null, [100, 0, 0]) : material),
    [matMode, matCmyk, material]
  );

  const out = useMemo(() => {
    const paper = labToLin(materialLab);
    const cur01 = current.map((v) => v / 100);
    const tLab = targetMode === "cmyk"
      ? cmykToLab(targetCmyk.map((v) => v / 100), gain, paper, activeLut, [100, 0, 0])
      : [...targetLabIn];
    const cLab = pressMode === "lab"
      ? [...pressLabIn]
      : cmykToLab(cur01, gain, paper, activeLut, materialLab);
    const dE = deltaE00(tLab, cLab);

    const solved = solveCorrection(cur01, tLab, gain, paper, activeLut, materialLab, cLab);
    const rec = solved.map((v, i) => Math.round(v * 100) - current[i]);
    const applied = current.map((v, i) => clamp(v + rec[i], 0, 100));
    const predictedApplied = cmykToLab(applied.map((v) => v / 100), gain, paper, activeLut, materialLab);
    const measOffset = pressMode === "lab"
      ? [cLab[0] - cmykToLab(cur01, gain, paper, activeLut, materialLab)[0],
         cLab[1] - cmykToLab(cur01, gain, paper, activeLut, materialLab)[1],
         cLab[2] - cmykToLab(cur01, gain, paper, activeLut, materialLab)[2]]
      : [0, 0, 0];
    const dEafter = deltaE00(tLab, [predictedApplied[0] + measOffset[0], predictedApplied[1] + measOffset[1], predictedApplied[2] + measOffset[2]]);

    // plain-language read of the drift
    const dL = tLab[0] - cLab[0], da = tLab[1] - cLab[1], db = tLab[2] - cLab[2];
    const drift = [];
    if (dL < -1.5) drift.push("running light");
    if (dL > 1.5) drift.push("running dark");
    if (da > 1.5) drift.push("too green");
    if (da < -1.5) drift.push("too red");
    if (db > 1.5) drift.push("too blue");
    if (db < -1.5) drift.push("too yellow");

    return { tLab, cLab, dE, rec, applied, dEafter, drift };
  }, [current, targetCmyk, targetLabIn, targetMode, gain, materialLab, activeLut, pressMode, pressLabIn]);

  const verdict = isPro
    ? (out.dE <= 1 ? "Dead match. Leave it alone."
      : out.dE <= tol ? `Passes inside your ΔE ${tol.toFixed(1)} tolerance.`
      : out.dE <= tol + 1.5 ? "Just outside tolerance — worth the move."
      : "Off. The client will see it.")
    : (out.dE <= 1 ? "Dead match. Leave it alone."
      : out.dE <= 2 ? "Commercial match. Most clients pass this."
      : out.dE <= 3.5 ? "Visible in a side-by-side."
      : "Off. The client will see it.");

  const noMove = out.rec.every((d) => d === 0);
  const outOfReach = out.dEafter > (isPro ? tol : 2.5);

  const activeProfile = PROFILES.find((p) => p.id === profileId);
  const inkTotal = out.applied.reduce((s, v) => s + v, 0);
  const tacOver = isPro && !noMove && inkTotal > activeProfile.tac;

  const copyTicket = () => {
    const fmt = (l) => `L ${l[0].toFixed(1)} a ${l[1].toFixed(1)} b ${l[2].toFixed(1)}`;
    const lines = [
      `DRAWDOWN CORRECTION — ${isPro ? activeProfile.name : `generic ${stock}`}`,
      ...(TIER === "shop" && SHOP_NAME ? [`Shop: ${SHOP_NAME}`] : []),
      `Target: ${targetMode === "cmyk" ? targetCmyk.join("/") + "  " : ""}${fmt(out.tLab)}`,
      `On press/printer: ${current.join("/")}  ${fmt(out.cLab)}  ΔE00 ${out.dE.toFixed(1)}`,
      `Moves: ${CHANNELS.map((c, i) => `${c.key} ${out.rec[i] > 0 ? "+" : ""}${out.rec[i]}`).join(" · ")}`,
      `New build: ${out.applied.join("/")}  predicted ΔE00 ${out.dEafter.toFixed(1)}`,
      `Material: ${fmt(materialLab)}`,
      `Drawdown v${VERSION}`,
    ];
    navigator.clipboard?.writeText(lines.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const setT = (i, v) => setTargetCmyk(targetCmyk.map((x, j) => (j === i ? v : x)));
  const setC = (i, v) => setCurrent(current.map((x, j) => (j === i ? v : x)));
  const setPL = (i, v) => setPressLabIn(pressLabIn.map((x, j) => (j === i ? v : x)));
  const setL = (i, v) => setTargetLabIn(targetLabIn.map((x, j) => (j === i ? v : x)));
  const setM = (i, v) => setMaterial(material.map((x, j) => (j === i ? v : x)));
  const setMc = (i, v) => setMatCmyk(matCmyk.map((x, j) => (j === i ? v : x)));

  return (
    <div className="wrap">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;800&family=IBM+Plex+Mono:wght@500;600&display=swap');
        .wrap { min-height: 100vh; background: #F6F5F1; color: #000; font-family: 'Archivo', sans-serif; padding: 28px 16px 64px; }
        .inner { max-width: 720px; margin: 0 auto; }
        .mast { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
        .mark { font-weight: 800; font-size: 30px; letter-spacing: -0.02em; }
        .markrow { display: flex; align-items: center; gap: 10px; }
        .logomark { display: block; flex: none; }
        .tierbadge { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 3px; border: 1.5px solid #000; white-space: nowrap; }
        .tierbadge.free { background: #fff; color: #000; }
        .tierbadge.pro { background: #000; color: #fff; }
        .tierbadge.shop { background: #0A72B5; color: #fff; border-color: #0A72B5; }
        .prolink { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 12.5px; background: none; border: 0; padding: 3px 2px; cursor: pointer; color: #000; text-decoration: underline; text-underline-offset: 3px; }
        .navlink { font-family: 'Archivo', sans-serif; font-weight: 600; font-size: 12.5px; background: none; border: 0; padding: 3px 2px; cursor: pointer; color: #555; text-decoration: underline; text-underline-offset: 3px; }
        .about { margin-top: 8px; }
        .abouthead { font-weight: 800; font-size: 22px; margin: 24px 0 8px; }
        .abouth { font-weight: 800; font-size: 16px; margin: 22px 0 6px; }
        .aboutp { font-size: 14.5px; line-height: 1.6; color: #222; margin: 0 0 10px; max-width: 64ch; }
        .aboutp a { color: #000; }
        .about ol { padding-left: 20px; margin: 6px 0; max-width: 64ch; }
        .about li { font-size: 14.5px; line-height: 1.6; margin-bottom: 7px; }
        .propill { font-size: 11px; font-weight: 700; background: #000; color: #fff; padding: 2px 7px; border-radius: 3px; vertical-align: middle; margin-left: 6px; }
        .tag { font-size: 14px; color: #444; margin-top: 2px; }
        .firsttime { font-size: 13px; color: #555; margin-top: 8px; background: #EFEEE8; border: 1px solid #E0DDD4; border-radius: 4px; padding: 8px 11px; max-width: 560px; }
        .ftlink { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 13px; background: none; border: 0; padding: 0; cursor: pointer; color: #0A72B5; text-decoration: underline; text-underline-offset: 2px; }
        .seg { display: inline-flex; border: 1.5px solid #000; border-radius: 3px; overflow: hidden; }
        .seg button { font-family: 'Archivo'; font-weight: 600; font-size: 13px; padding: 7px 14px; background: #fff; border: 0; cursor: pointer; }
        .seg button.on { background: #000; color: #fff; }
        .hero { margin-top: 26px; }
        .patches { display: flex; height: 150px; border-radius: 3px; overflow: hidden; box-shadow: 0 1px 0 #00000022; }
        .patches > div { flex: 1; }
        .patchlbls { display: flex; font-size: 13px; color: #333; margin-top: 6px; }
        .patchlbls span { flex: 1; }
        .patchlbls span:last-child { text-align: right; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .de { display: flex; align-items: baseline; gap: 14px; margin-top: 18px; flex-wrap: wrap; }
        .deval { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 52px; line-height: 1; }
        .delbl { font-size: 13px; color: #555; }
        .verdict { font-size: 16px; font-weight: 600; }
        .panel { background: #fff; border: 1px solid #DDD9CF; border-radius: 3px; padding: 16px 16px 8px; margin-top: 22px; }
        .phead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .ptitle { font-weight: 800; font-size: 16px; }
        .psub { font-size: 13px; color: #555; }
        .chrow { display: grid; grid-template-columns: 34px 1fr 64px; gap: 12px; align-items: center; margin-bottom: 12px; }
        .chchip { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 30px; border-radius: 3px; font-weight: 800; font-size: 14px; }
        .chrow input[type=range] { width: 100%; height: 30px; }
        .chrow input[type=range]:disabled { opacity: 0.35; cursor: not-allowed; }
        .numin { font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 500; width: 64px; padding: 5px 6px; border: 1.5px solid #000; border-radius: 3px; background: #fff; }
        .labgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
        .labgrid label { font-size: 13px; font-weight: 600; display: block; margin-bottom: 4px; }
        .labgrid input { width: 100%; box-sizing: border-box; }
        .labnote { font-size: 13px; color: #555; margin: 2px 0 10px; }
        .miniseg { display: inline-flex; border: 1.5px solid #000; border-radius: 3px; overflow: hidden; }
        .miniseg button { font-family: 'Archivo'; font-weight: 600; font-size: 12px; padding: 5px 10px; background: #fff; border: 0; cursor: pointer; }
        .miniseg button.on { background: #000; color: #fff; }
        .presets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
        .presets button { font-family: 'Archivo'; font-weight: 600; font-size: 12.5px; padding: 6px 10px; border: 1.5px solid #000; border-radius: 3px; background: #fff; cursor: pointer; }
        .presets button.on { background: #000; color: #fff; }
        .stockframe { padding: 12px; border-radius: 4px; border: 1px solid #DDD9CF; }
        .profsel { font-family: 'Archivo'; font-weight: 600; font-size: 13px; padding: 8px 10px; border: 1.5px solid #000; border-radius: 3px; background: #fff; max-width: 240px; }
        .numin:disabled { opacity: 0.4; background: #F1EFE9; cursor: not-allowed; }
        .pressbuild { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; flex-wrap: wrap; }
        .pressbuildlbl { font-size: 13px; font-weight: 600; color: #555; }
        .numin.sm { width: 52px; }
        .buildfield { display: inline-flex; align-items: center; gap: 4px; }
        .buildkey { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 13px; color: #333; }
        .pronote { font-size: 12.5px; color: #555; margin: 6px 0 10px; }
        .corr { margin-top: 26px; }
        .corrtitle { font-weight: 800; font-size: 20px; }
        .driftline { font-size: 15px; margin-top: 6px; }
        .moves { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
        .move { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 18px; padding: 10px 14px; border-radius: 3px; border: 1.5px solid #000; background: #fff; display: flex; align-items: center; gap: 8px; }
        .move .dot { width: 14px; height: 14px; border-radius: 2px; display: inline-block; }
        .move.zero { border-color: #C9C5BA; color: #999; }
        .after { font-size: 14px; margin-top: 14px; color: #222; }
        .after .mono { font-weight: 600; }
        .warn { margin-top: 10px; font-size: 14px; color: #8A2B00; display: flex; align-items: flex-start; gap: 7px; }
        .warnicon { flex: none; margin-top: 1px; }
        .tolrow { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
        .tollbl { font-size: 13px; font-weight: 600; color: #555; }
        .ticketbtn { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 13.5px; padding: 9px 14px; border: 1.5px solid #000; border-radius: 3px; background: #fff; cursor: pointer; margin-top: 16px; }
        .ticketbtn:disabled { border-color: #C9C5BA; color: #999; cursor: not-allowed; }
        .foot { margin-top: 34px; font-size: 12.5px; color: #666; line-height: 1.5; border-top: 1px solid #DDD9CF; padding-top: 14px; }
        .prohead { font-weight: 700; color: #000; }
        .foot a { color: #000; }
        .ver { margin-top: 10px; font-size: 11.5px; color: #9A968C; }
        .cardline { margin-top: 10px; font-size: 12.5px; color: #666; }
        .cardline a { color: #000; font-weight: 600; }
        @media (max-width: 540px) {
          .wrap { padding: 18px 12px 48px; }
          .mast { flex-direction: column; align-items: flex-start; gap: 12px; }
          .mark { font-size: 24px; }
          .tag { font-size: 13px; }
          .deval { font-size: 40px; }
          .patches { height: 110px; }
          .verdict { font-size: 15px; }
          .corrtitle { font-size: 18px; }
          .phead { flex-wrap: wrap; gap: 8px; }
          /* slider rows: give the number box less room, keep the track from overflowing */
          .chrow { grid-template-columns: 30px 1fr 52px; gap: 8px; }
          .chchip { width: 30px; }
          .numin { width: 52px; font-size: 14px; padding: 5px 4px; }
          /* correction chips: full flex wrap, each sized to content, consistent rows */
          .moves { gap: 8px; }
          .move { font-size: 15px; padding: 8px 10px; flex: 1 1 calc(50% - 8px); justify-content: center; }
          /* target/material Lab grid stays 3-up but tighter */
          .labgrid { gap: 8px; }
          .patchlbls { font-size: 11px; }
          .patchlbls .mono { font-size: 10px; }
          .about ol, .aboutp, .about li { max-width: 100%; }
        }
        @media (max-width: 360px) {
          .move { flex-basis: 100%; }
          .deval { font-size: 34px; }
        }
      `}</style>

      <div className="inner">
        <header className="mast">
          <div>
            <div className="markrow">
              <Mark />
              <div className="mark">Drawdown</div>
              <span className={`tierbadge ${TIER}`}>
                {TIER === "shop" ? (SHOP_NAME ? `Shop — ${SHOP_NAME}` : "Shop license") : isPro ? "Pro version" : "Free version"}
              </span>
              {!isPro && (
                PRO_URL ? (
                  <a className="prolink" href={PRO_URL} target="_blank" rel="noreferrer">Get Pro</a>
                ) : (
                  <button
                    className="prolink"
                    onClick={() => document.getElementById("pro-pitch")?.scrollIntoView({ behavior: "smooth" })}
                  >Get Pro</button>
                )
              )}
              <button className="navlink" onClick={() => setPage(page === "about" ? "app" : "about")}>
                {page === "about" ? "Back to the tool" : "How to use"}
              </button>
            </div>
            <div className="tag">Two colors in, ink moves out. Tell it what's printing — it tells you what to move.</div>
            {page === "app" && (
              <div className="firsttime">
                First time? Enter your target and what's on press/printer — Drawdown tells you what to move.{" "}
                <button className="ftlink" onClick={() => setPage("about")}>Full walkthrough →</button>
              </div>
            )}
          </div>
          {isPro ? (
            <select
              className="profsel" value={profileId} aria-label="Press profile"
              onChange={(e) => setProfileId(e.target.value)}
            >
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value="custom" disabled>Your press profile — arrives with the ICC engine</option>
            </select>
          ) : (
            <div className="seg" role="group" aria-label="Stock">
              <button className={stock === "coated" ? "on" : ""} onClick={() => setStock("coated")}>Coated</button>
              <button className={stock === "uncoated" ? "on" : ""} onClick={() => setStock("uncoated")}>Uncoated</button>
            </div>
          )}
        </header>

        {page === "about" ? (
          <About />
        ) : (
          <>
        <section className="hero" aria-label="Comparison">
          <div className="stockframe" style={{ background: labToCss(materialLab) }}>
            <div className="patches">
              <div style={{ background: labToCss(out.tLab) }} />
              <div style={{ background: labToCss(out.cLab) }} />
            </div>
          </div>
          <div className="patchlbls">
            <span>Target &nbsp;<span className="mono">L {out.tLab[0].toFixed(1)} · a {out.tLab[1].toFixed(1)} · b {out.tLab[2].toFixed(1)}</span></span>
            <span>On press/printer &nbsp;<span className="mono">L {out.cLab[0].toFixed(1)} · a {out.cLab[1].toFixed(1)} · b {out.cLab[2].toFixed(1)}</span></span>
          </div>
          <div className="de">
            <div>
              <div className="deval">{out.dE.toFixed(1)}</div>
              <div className="delbl">ΔE2000</div>
            </div>
            <div className="verdict">{verdict}</div>
          </div>
          {isPro && (
            <div className="tolrow">
              <span className="tollbl">Pass line</span>
              <div className="miniseg" role="group" aria-label="Tolerance">
                {[1, 2, 3.5].map((t) => (
                  <button key={t} className={tol === t ? "on" : ""} onClick={() => setTol(t)}>ΔE {t}</button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="phead">
            <div>
              <div className="ptitle">Target</div>
              <div className="psub">The color you're chasing</div>
            </div>
            <div className="miniseg" role="group" aria-label="Target input mode">
              <button className={targetMode === "cmyk" ? "on" : ""} onClick={() => setTargetMode("cmyk")}>CMYK</button>
              <button className={targetMode === "lab" ? "on" : ""} onClick={() => setTargetMode("lab")}>{!isPro ? "Lab · Pro" : "Lab"}</button>
            </div>
          </div>
          {targetMode === "cmyk" ? (
            CHANNELS.map((c, i) => (
              <ChannelRow key={c.key} ch={i} value={targetCmyk[i]} onChange={(v) => setT(i, v)} />
            ))
          ) : (
            <>
              <div className="labnote">Type the readout from your spectro or the chip's published Lab values — no color library needed.</div>
              <div className="labgrid">
                {["L", "a", "b"].map((n, i) => (
                  <div key={n}>
                    <label htmlFor={`lab-${n}`}>{n}</label>
                    <input
                      id={`lab-${n}`} className="numin" type="number" step="0.1"
                      min={i === 0 ? 0 : -128} max={i === 0 ? 100 : 127}
                      value={targetLabIn[i]}
                      disabled={!isPro}
                      onChange={(e) => setL(i, Number(e.target.value) || 0)}
                    />
                  </div>
                ))}
              </div>
              {!isPro && (
                <div className="pronote">Lab targets are a Pro feature — the free version works in CMYK.</div>
              )}
            </>
          )}
        </section>

        <section className="panel">
          <div className="phead">
            <div>
              <div className="ptitle">On press/printer</div>
              <div className="psub">{pressMode === "lab" ? "Measure the sheet, enter the reading" : "The build that's running now"}</div>
            </div>
            <div className="miniseg" role="group" aria-label="On press input mode">
              <button className={pressMode === "cmyk" ? "on" : ""} onClick={() => setPressMode("cmyk")}>CMYK</button>
              <button className={pressMode === "lab" ? "on" : ""} onClick={() => isPro && setPressMode("lab")}>{!isPro ? "Lab · Pro" : "Lab"}</button>
            </div>
          </div>
          {pressMode === "cmyk" ? (
            <>
              {CHANNELS.map((c, i) => (
                <ChannelRow key={c.key} ch={i} value={current[i]} onChange={(v) => setC(i, v)} />
              ))}
              {isPro && (
                <div className="labnote">Tip: measure the printed sheet and switch to Lab for a measurement-accurate correction.</div>
              )}
            </>
          ) : (
            <>
              <div className="labnote">Enter the i1/spectro reading of the printed sheet. The build below is what the correction adjusts from — keep it set to what you're actually running.</div>
              <div className="labgrid">
                {["L", "a", "b"].map((n, i) => (
                  <div key={n}>
                    <label htmlFor={`press-${n}`}>{n}</label>
                    <input
                      id={`press-${n}`} className="numin" type="number" step="0.1"
                      min={i === 0 ? 0 : -128} max={i === 0 ? 100 : 127}
                      value={pressLabIn[i]}
                      onChange={(e) => setPL(i, Number(e.target.value) || 0)}
                    />
                  </div>
                ))}
              </div>
              <div className="pressbuild">
                <span className="pressbuildlbl">Build running:</span>
                {CHANNELS.map((c, i) => (
                  <span key={c.key} className="buildfield">
                    <span className="buildkey">{c.key}=</span>
                    <input className="numin sm" type="number" min={0} max={100}
                      value={current[i]} aria-label={`${c.name} build`}
                      onChange={(e) => setC(i, clamp(Number(e.target.value) || 0, 0, 100))} />
                  </span>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <div className="phead">
            <div>
              <div className="ptitle">Material</div>
              <div className="psub">The white under the ink — spectro the unprinted stock, or describe its cast</div>
            </div>
            <div className="miniseg" role="group" aria-label="Material input mode">
              <button className={matMode === "cmyk" ? "on" : ""} onClick={() => setMatMode("cmyk")}>CMYK</button>
              <button className={matMode === "lab" ? "on" : ""} onClick={() => setMatMode("lab")}>{!isPro ? "Lab · Pro" : "Lab"}</button>
            </div>
          </div>
          <div className="presets">
            {MATERIALS.map((m) => (
              <button
                key={m.name}
                className={matMode === "lab" && material.join() === m.lab.join() ? "on" : ""}
                onClick={() => { setMaterial([...m.lab]); setMatMode("lab"); }}
              >{m.name}</button>
            ))}
          </div>
          {matMode === "cmyk" ? (
            <>
              <div className="labnote">Describe the stock's cast as a light tint — a touch of Y for warm stock, a point or two of K for grey. (Real substrates only need a few percent, so these run 0–15.)</div>
              {CHANNELS.map((c, i) => (
                <ChannelRow key={c.key} ch={i} value={matCmyk[i]} onChange={(v) => setMc(i, v)} max={15} />
              ))}
            </>
          ) : (
            <>
              <div className="labgrid">
                {["L", "a", "b"].map((n, i) => (
                  <div key={n}>
                    <label htmlFor={`mat-${n}`}>{n}</label>
                    <input
                      id={`mat-${n}`} className="numin" type="number" step="0.1"
                      min={i === 0 ? 0 : -128} max={i === 0 ? 100 : 127}
                      value={material[i]}
                      disabled={!isPro}
                      onChange={(e) => setM(i, Number(e.target.value) || 0)}
                    />
                  </div>
                ))}
              </div>
              {!isPro && (
                <div className="pronote">Typing your own spectro readings is a Pro feature — the presets above are free.</div>
              )}
            </>
          )}
        </section>

        <section className="corr" aria-label="Correction">
          <div className="corrtitle">The correction</div>
          <div className="driftline">
            {out.dE <= 1
              ? "You're inside a drawdown match — don't chase it."
              : out.drift.length
                ? `Against the target you're ${out.drift.join(", ").replace(/, ([^,]*)$/, " and $1")}.`
                : "The drift is mostly in hue — small moves below."}
          </div>
          <div className="moves">
            {CHANNELS.map((c, i) => (
              <span key={c.key} className={`move${out.rec[i] === 0 ? " zero" : ""}`}>
                <span className="dot" style={{ background: c.color }} />
                {c.key} {out.rec[i] > 0 ? `+${out.rec[i]}` : out.rec[i] === 0 ? "±0" : out.rec[i]}
              </span>
            ))}
          </div>
          <div className="after">
            {noMove ? (
              <>No whole-point move improves this build.</>
            ) : (
              <>
                New build <span className="mono">{out.applied.join(" / ")}</span> — predicted ΔE2000{" "}
                <span className="mono">{out.dEafter.toFixed(1)}</span> after correction.
              </>
            )}
          </div>
          {outOfReach && (
            <div className="warn">
              <WarnIcon />
              <span>This target may sit outside what {isPro ? activeProfile.name : `${stock} stock`} can
              hit — the moves above are the closest achievable.</span>
            </div>
          )}
          {tacOver && (
            <div className="warn">
              <WarnIcon />
              <span>The corrected build totals {inkTotal}% ink — over this profile's {activeProfile.tac}% coverage
              limit. Expect drying and setoff trouble; bring the total down before running it.</span>
            </div>
          )}
          <div>
            {isPro ? (
              <button className="ticketbtn" onClick={copyTicket} disabled={noMove}>
                {copied ? "Copied to clipboard" : "Copy for the job ticket"}
              </button>
            ) : (
              <button className="ticketbtn" disabled>Copy for the job ticket · Pro</button>
            )}
          </div>
        </section>
          </>
        )}

        <footer className="foot">
          {isPro && activeLut ? (
            <>Running the measured profile table for {PROFILES.find((p) => p.id === profileId).name} over
            your material white — ΔE2000 and a per-channel sensitivity solve from your current operating point.</>
          ) : isPro ? (
            <>No profile table found for {PROFILES.find((p) => p.id === profileId).name} — running the generic
            model as a fallback. Generate the table with make_lut.py and place the JSON in public/luts/, then reload.</>
          ) : (
            <>
              <span className="prohead" id="pro-pitch">Drawdown Pro — dial in by the numbers.</span> The free version
              runs a generic press model: right direction, ballpark distance. Pro runs real ICC press
              profiles — GRACoL, SWOP, or your own printer's — and unlocks spectro Lab entry for targets
              and materials, so the moves it hands you are the profile's own answers, not a model's
              estimate. Pro is coming soon. For early access, or to tell us something's off, write{" "}
              <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
            </>
          )}
          <div className="ver mono">Drawdown v{VERSION}</div>
          <div className="cardline">
            Printed Gray Balance Card — a pocket reference for the press.{" "}
            {CARD_URL ? (
              <a href={CARD_URL} target="_blank" rel="noreferrer">Order cards</a>
            ) : (
              <a href={`mailto:${CONTACT}?subject=${encodeURIComponent("Gray Balance Card order")}&body=${encodeURIComponent("I'd like to order the Drawdown Gray Balance Card.\n\nQuantity:\nName:\nShipping address:\n\n(I'll reply with payment details.)")}`}>Buy now</a>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
