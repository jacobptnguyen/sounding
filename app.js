const consoleEl = document.getElementById("console");
const form = document.getElementById("search-form");
const input = document.getElementById("prompt-input");
const statusEl = document.getElementById("status");
const stageEl = document.getElementById("stage");
const gaugeEl = document.getElementById("depth-gauge");
const gaugeList = gaugeEl.querySelector("ol");
const announcerEl = document.getElementById("announcer");

// Even a fast response gets a full, unhurried dive; a slow one just descends longer.
const MIN_DESCENT_MS = 900;
const DEEPEST_ZONE = DEPTH_ZONES.length - 1;

const finds = [];
let current = -1;
let busy = false;
let bob = null;

class DiveError extends Error {}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, "0");
// Find i sits one zone below the surface per find, bottoming out at the deepest.
const zoneForFind = (i) => Math.min(i + 1, DEEPEST_ZONE);

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

function displayName(taxon) {
  return taxon.preferred_common_name || taxon.name;
}

function showStatus(message, type = "info") {
  gsap.killTweensOf(statusEl);
  if (REDUCED_MOTION) {
    statusEl.dataset.type = type;
    statusEl.textContent = message;
    return;
  }
  gsap.to(statusEl, {
    opacity: 0,
    duration: 0.12,
    onComplete: () => {
      statusEl.dataset.type = type;
      statusEl.textContent = message;
      gsap.fromTo(statusEl, { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: 0.25, ease: "expo.out" });
    },
  });
}

// Identification is three stages, and Claude only owns the first one.
//
// 1. /api/identify proposes several candidate species (recall).
// 2. WoRMS, the marine register, validates them (precision). One batched call
//    fixes misspellings, resolves outdated names, and rejects anything that
//    isn't a marine species.
// 3. iNaturalist is asked only for a photo and a description, using a clean
//    accepted binomial rather than whatever was typed into the box.
//
// The old flow skipped straight from a single guess to `?q=<guess>&per_page=1`,
// which sorts by observation count rather than match quality: searching "seal"
// returned Ranunculaceae, the buttercup family, via "goldenseal".

const WORMS_MATCH = "https://www.marinespecies.org/rest/AphiaRecordsByMatchNames";
const INAT_TAXA = "https://api.inaturalist.org/v1/taxa";

// Both registries are public goods with no API key and no quota of our own;
// a 429 means we're being told to slow down, not that the animal is missing.
const RATE_LIMITED = "Being rate-limited by the species databases. Wait a few seconds and dive again.";

// Returns accepted marine binomials, best first. Empty means nothing matched.
async function verifyMarine(candidates) {
  const url = new URL(WORMS_MATCH);
  for (const c of candidates) url.searchParams.append("scientificnames[]", c.scientific_name);
  url.searchParams.set("marine_only", "true");

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new DiveError("Couldn’t reach the marine species register. Try again.");
  }
  if (res.status === 204) return []; // register knows none of them as marine
  if (res.status === 429) throw new DiveError(RATE_LIMITED);
  if (!res.ok) throw new DiveError("Couldn’t reach the marine species register. Try again.");

  // One array per name submitted, in order; a name that matched nothing is [].
  const groups = await res.json();
  const names = [];
  for (const group of groups) {
    const rec = group.find((r) => r.rank === "Species");
    if (!rec) continue;
    // An unaccepted name is a synonym: valid_name is the current one.
    const name = rec.status === "accepted" ? rec.scientificname : rec.valid_name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Off the happy path: no proposed binomial reached the register. The common
// names may still land — GBIF's vernacular coverage is far better than WoRMS'
// (which lists exactly one name for the common clownfish, in Japanese) — so
// turn those into binomials and run them back through the register.
async function viaCommonNames(candidates) {
  const BACKBONE = "d7dddbf4-2cf0-4f39-9b2a-bb099caae36c"; // GBIF Backbone Taxonomy
  const found = [];
  for (const c of candidates.slice(0, 2)) {
    if (!c.common_name) continue;
    const url =
      `https://api.gbif.org/v1/species/search?q=${encodeURIComponent(c.common_name)}` +
      `&qField=VERNACULAR&rank=SPECIES&datasetKey=${BACKBONE}&limit=5`;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) continue;
    const data = await res.json();
    for (const r of data.results || []) {
      if (r.species && !found.some((f) => f.scientific_name === r.species)) {
        found.push({ scientific_name: r.species });
      }
    }
  }
  return found.length ? verifyMarine(found) : [];
}

// Verified names in, one displayable taxon out. Photos are required (the card
// is mostly photo); a description is strongly preferred but not worth failing
// the whole dive over.
//
// One request at a time, stopping at the first good match. This used to fan
// out a search per verified name in parallel, which fired five calls inside
// 300ms — iNaturalist asks for roughly one request per second. The top
// candidate is usually right, so in practice this is two calls: fewer than the
// fan-out, and no more than the original single-guess code made.
async function findOnINaturalist(names) {
  let withoutSummary = null;

  for (const name of names.slice(0, 3)) {
    const res = await fetch(
      `${INAT_TAXA}?q=${encodeURIComponent(name)}&rank=species&per_page=1`
    ).catch(() => null);
    if (res && res.status === 429) throw new DiveError(RATE_LIMITED);
    if (!res || !res.ok) continue;

    // default_photo is on the search result, so a photo-less taxon is dropped
    // before it costs a detail call.
    const hit = (await res.json()).results?.[0];
    if (!hit || !hit.default_photo) continue;

    // wikipedia_summary is detail-only, so the description needs this hop.
    const detailRes = await fetch(`${INAT_TAXA}/${hit.id}`).catch(() => null);
    if (detailRes && detailRes.status === 429) throw new DiveError(RATE_LIMITED);
    if (!detailRes || !detailRes.ok) continue;
    const taxon = (await detailRes.json()).results?.[0];
    if (!taxon) continue;

    taxon.preferred_common_name = taxon.preferred_common_name || hit.preferred_common_name;
    if (taxon.wikipedia_summary) return taxon; // photo and description: done
    withoutSummary = withoutSummary || taxon;
  }

  return withoutSummary;
}

async function identifyTaxon(prompt) {
  const identifyRes = await fetch("/api/identify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  // The firewall's rate limit answers before our function runs, without a JSON body.
  if (identifyRes.status === 429) throw new DiveError("Too many dives in a row. Wait a minute and try again.");
  const identifyData = await identifyRes.json();
  if (!identifyRes.ok) throw new DiveError(identifyData.error || "Something went wrong.");

  const candidates = identifyData.candidates || [];
  // The model is allowed to abstain rather than invent a plausible species.
  if (!candidates.length) {
    throw new DiveError("That doesn’t sound like anything that lives in the sea.");
  }

  let names = await verifyMarine(candidates);
  if (!names.length) names = await viaCommonNames(candidates);
  if (!names.length) {
    throw new DiveError("Couldn’t find a marine species matching that. Try describing it differently.");
  }

  const taxon = await findOnINaturalist(names);
  if (!taxon) throw new DiveError("Found the species, but no photo of it. Try describing something else.");
  return taxon;
}

// The photo is front and center now, so try iNaturalist's large size first.
// Preloading during the descent means the card never arrives half-painted.
function loadPhoto(taxon) {
  const medium = taxon.default_photo && taxon.default_photo.medium_url;
  if (!medium) return Promise.resolve("");
  const tryLoad = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(src);
      img.onerror = reject;
      img.src = src;
    });
  const photo = tryLoad(medium.replace("/medium.", "/large.")).catch(() => tryLoad(medium)).catch(() => "");
  return Promise.race([photo, wait(3000).then(() => medium)]);
}

function buildCard(find, index) {
  const { taxon, photoUrl } = find;
  const card = document.createElement("article");
  card.className = photoUrl ? "creature-card" : "creature-card no-photo";

  if (photoUrl) {
    const figure = document.createElement("figure");
    figure.className = "card-media";
    const img = document.createElement("img");
    img.src = photoUrl;
    img.alt = displayName(taxon);
    const dims = taxon.default_photo.original_dimensions;
    if (dims) {
      img.width = dims.width;
      img.height = dims.height;
    }
    figure.append(img);
    const attribution = taxon.default_photo && taxon.default_photo.attribution;
    if (attribution) {
      const caption = document.createElement("figcaption");
      caption.textContent = attribution;
      figure.append(caption);
    }
    card.append(figure);
  }

  const text = document.createElement("div");
  text.className = "card-text";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `Find ${pad(index + 1)}`;

  const name = document.createElement("h2");
  name.textContent = displayName(taxon);
  text.append(eyebrow, name);

  if (taxon.name !== name.textContent) {
    const sci = document.createElement("p");
    sci.className = "scientific-name";
    sci.textContent = taxon.name;
    text.append(sci);
  }

  const desc = document.createElement("p");
  desc.className = "description";
  desc.tabIndex = 0;
  desc.textContent = taxon.wikipedia_summary ? stripHtml(taxon.wikipedia_summary) : "No description available.";
  text.append(desc);

  card.append(text);
  return card;
}

// ---- Slides: one full-screen, snap-scrolled slide per find ----

const slideAt = (i) => stageEl.children[i];
const cardAt = (i) => slideAt(i) && slideAt(i).querySelector(".creature-card");

function addSlide(index) {
  const slide = document.createElement("section");
  slide.className = "slide";
  slide.setAttribute("aria-label", `Find ${pad(index + 1)}: ${displayName(finds[index].taxon)}`);
  const card = buildCard(finds[index], index);
  slide.append(card);
  stageEl.append(slide);
  return card;
}

// You sink past the creature on screen, so it rises away.
function sinkPast(card) {
  if (!card) return;
  if (REDUCED_MOTION) gsap.to(card, { opacity: 0, duration: 0.2, overwrite: "auto" });
  else gsap.to(card, { y: -80, opacity: 0, duration: 0.4, ease: "expo.out", overwrite: "auto" });
}

function restoreCard(card, animate) {
  if (!card) return;
  if (!animate || REDUCED_MOTION) {
    gsap.killTweensOf(card);
    gsap.set(card, { clearProps: "transform,opacity" });
    return;
  }
  gsap.fromTo(card, { y: -40 }, { y: 0, opacity: 1, duration: 0.5, ease: "expo.out", overwrite: "auto", clearProps: "transform,opacity" });
}

function revealCard(card) {
  if (REDUCED_MOTION) {
    gsap.from(card, { opacity: 0, duration: 0.2 });
    return;
  }
  const photo = card.querySelector(".card-media");
  const lines = card.querySelectorAll(".card-text > *");
  const tl = gsap.timeline();
  tl.from(card, { y: 40, duration: 0.8, ease: "expo.out" }, 0);
  if (photo) {
    tl.fromTo(
      photo,
      { opacity: 0, scale: 0.96, filter: "blur(8px)" },
      { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.5, ease: "expo.out", clearProps: "filter" },
      0
    );
  }
  tl.from(lines, { opacity: 0, y: 12, duration: 0.5, ease: "expo.out", stagger: 0.06 }, 0.12);
}

function markCurrent(index) {
  current = index;
  updateGauge();
  setReadout(`Find ${pad(index + 1)} of ${pad(finds.length)}`);
}

// ---- Scroll drives depth ----

let lastScrollTop = 0;
let ignoreScroll = false;
let scrollFrame = 0;

// Jump without the scroll handler treating it as the user scrolling.
function jumpTo(index) {
  const top = slideAt(index).offsetTop;
  if (stageEl.scrollTop === top) return;
  ignoreScroll = true;
  stageEl.scrollTop = top;
}

function syncToScroll() {
  scrollFrame = 0;
  const top = stageEl.scrollTop;
  const delta = top - lastScrollTop;
  lastScrollTop = top;
  if (ignoreScroll) {
    ignoreScroll = false;
    return;
  }
  if (!finds.length || busy) return;

  const position = top / stageEl.clientHeight;
  applyDepthAt(Math.min(position + 1, DEEPEST_ZONE));
  scrollRush(delta);

  const nearest = Math.min(Math.round(position), finds.length - 1);
  if (nearest !== current) {
    markCurrent(nearest);
    announcerEl.textContent = `${displayName(finds[nearest].taxon)}, find ${nearest + 1} of ${finds.length}`;
  }
}

stageEl.addEventListener(
  "scroll",
  () => {
    if (!scrollFrame) scrollFrame = requestAnimationFrame(syncToScroll);
  },
  { passive: true }
);

function canScrollFurther(el, direction) {
  if (!el) return false;
  return direction > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
}

// Snap alone treats a single mouse-wheel notch as "too small, snap back", so
// each wheel gesture (a notch, or a trackpad swipe plus its momentum) moves
// exactly one animal. Touch swipes don't fire wheel events and stay native.
let wheelLocked = false;
let wheelQuiet = 0;
stageEl.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey || busy || !finds.length) return;
    const direction = Math.sign(event.deltaY);
    if (!direction || canScrollFurther(event.target.closest(".description"), direction)) return;
    event.preventDefault();
    clearTimeout(wheelQuiet);
    wheelQuiet = setTimeout(() => (wheelLocked = false), 250);
    if (wheelLocked) return;
    wheelLocked = true;
    const target = Math.min(Math.max(current + direction, 0), finds.length - 1);
    if (target !== current) {
      stageEl.scrollTo({ top: slideAt(target).offsetTop, behavior: REDUCED_MOTION ? "auto" : "smooth" });
    }
  },
  { passive: false }
);

// ---- The search bar: floating, plunging, docking ----

function startBob() {
  if (REDUCED_MOTION || consoleEl.classList.contains("is-docked")) return;
  bob = gsap.to(consoleEl, { y: 5, duration: 1.5, ease: "sine.inOut", yoyo: true, repeat: -1 });
}

function stopBob() {
  if (bob) bob.kill();
  bob = null;
}

// Don't move a target while someone is aiming at or typing into it.
function holdBob(hold) {
  if (!bob) return;
  if (hold) bob.pause();
  else if (!consoleEl.matches(":hover, :focus-within")) bob.resume();
}
consoleEl.addEventListener("pointerenter", () => holdBob(true));
consoleEl.addEventListener("pointerleave", () => holdBob(false));
consoleEl.addEventListener("focusin", () => holdBob(true));
consoleEl.addEventListener("focusout", () => setTimeout(() => holdBob(false)));

// Instant dip (the response to Enter), then it sinks like it has weight.
function plungeBar() {
  stopBob();
  if (REDUCED_MOTION) return gsap.to(consoleEl, { opacity: 0, duration: 0.2 }).then();
  const rect = form.getBoundingClientRect();
  return gsap
    .timeline()
    .to(consoleEl, { y: "+=6", scale: 0.98, duration: 0.12, ease: "expo.out" })
    .add(() => emitBurst(rect.left + rect.width / 2, rect.top + rect.height / 2, rect.width))
    .fromTo(
      consoleEl,
      { filter: "blur(0px)" },
      { y: window.innerHeight, rotation: 4, filter: "blur(6px)", opacity: 0, duration: 0.65, ease: "power2.in" }
    )
    .then();
}

// Rises from below and settles; the glass sharpens as it arrives.
function surfaceBar(docked) {
  consoleEl.classList.toggle("is-docked", docked);
  if (REDUCED_MOTION) {
    gsap.set(consoleEl, { y: 0, rotation: 0, scale: 1 });
    return gsap.to(consoleEl, { opacity: 1, duration: 0.2 }).then();
  }
  return gsap
    .fromTo(
      consoleEl,
      { y: 120, rotation: 0, scale: 1, opacity: 0, filter: "blur(6px)" },
      { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "back.out(1.1)", clearProps: "filter" }
    )
    .then(startBob);
}

function leaveSurface() {
  consoleEl.querySelector(".surface-copy")?.remove();
  consoleEl.querySelector(".prompt-chips")?.remove();
}

// ---- Depth gauge ----

function updateGauge() {
  gaugeList.querySelectorAll(".gauge-marker").forEach((marker, i) => {
    if (i === current) marker.setAttribute("aria-current", "location");
    else marker.removeAttribute("aria-current");
  });
}

function addGaugeMarker(index) {
  const find = finds[index];
  const li = document.createElement("li");
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "gauge-marker";
  marker.style.setProperty("--marker-accent", DEPTH_ZONES[zoneForFind(index)].accent);
  marker.setAttribute("aria-label", `Find ${pad(index + 1)}: ${displayName(find.taxon)}`);

  const dot = document.createElement("span");
  dot.className = "gauge-dot";
  const label = document.createElement("span");
  label.className = "gauge-label";
  label.textContent = `${pad(index + 1)} · ${displayName(find.taxon)}`;
  label.setAttribute("aria-hidden", "true");

  marker.append(dot, label);
  marker.addEventListener("click", () => travelTo(index));
  li.append(marker);
  gaugeList.append(li);
  gaugeEl.hidden = false;
  if (!REDUCED_MOTION) gsap.from(li, { opacity: 0, scale: 0.6, duration: 0.4, ease: "expo.out" });
}

// Gauge travel is just a scroll: colour, bubbles and readout follow the
// scroll position, and a new click mid-scroll simply re-targets it.
function travelTo(index) {
  if (busy || index === current) return;
  stageEl.scrollTo({ top: slideAt(index).offsetTop, behavior: REDUCED_MOTION ? "auto" : "smooth" });
}

// ---- The dive ----

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt || busy) return;

  busy = true;
  document.body.classList.add("is-diving");
  const wasDocked = consoleEl.classList.contains("is-docked");
  const fromZone = current >= 0 ? zoneForFind(current) : 0;
  const toZone = zoneForFind(finds.length);
  const leaving = cardAt(current);

  consoleEl.inert = true;
  showStatus("");
  announcerEl.textContent = "Diving…";
  setReadout("Descending…");
  startDescent(1);
  sinkPast(leaving);
  setDepth(toZone);
  const plunged = plungeBar();
  const minDescent = wait(REDUCED_MOTION ? 0 : MIN_DESCENT_MS);

  try {
    const taxon = await identifyTaxon(prompt);
    const photoUrl = await loadPhoto(taxon);
    await Promise.all([plunged, minDescent]);

    finds.push({ taxon, photoUrl });
    const index = finds.length - 1;
    leaveSurface();
    const card = addSlide(index);
    jumpTo(index);
    restoreCard(leaving, false);
    settle();
    revealCard(card);
    addGaugeMarker(index);
    markCurrent(index);
    announcerEl.textContent = `${displayName(taxon)}, find ${index + 1} of ${finds.length}`;
    input.value = "";

    consoleEl.inert = false;
    busy = false;
    await surfaceBar(true);
    if (window.matchMedia("(pointer: fine)").matches) input.focus({ preventScroll: true });
  } catch (err) {
    await plunged;
    settle();
    setDepth(fromZone);
    restoreCard(leaving, true);
    setReadout(current >= 0 ? `Find ${pad(current + 1)} of ${pad(finds.length)}` : "Surface");
    const message = err instanceof DiveError ? err.message : "Something went wrong. Try again.";
    showStatus(message, "error");
    announcerEl.textContent = message;
    consoleEl.inert = false;
    busy = false;
    await surfaceBar(wasDocked);
  } finally {
    consoleEl.inert = false;
    busy = false;
    document.body.classList.remove("is-diving");
  }
});

document.querySelectorAll(".prompt-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (busy) return;
    input.value = chip.textContent.trim();
    form.requestSubmit();
  });
});

// One orchestrated arrival on load, then the bar starts floating.
(function intro() {
  if (REDUCED_MOTION) return;
  gsap.from(".brand > *", { opacity: 0, y: 12, duration: 0.6, ease: "expo.out", stagger: 0.06 });
  gsap.fromTo(
    consoleEl,
    { opacity: 0, y: 24, filter: "blur(6px)" },
    {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      duration: 0.8,
      delay: 0.15,
      ease: "expo.out",
      clearProps: "filter",
      onComplete: startBob,
    }
  );
})();
