// Checks the identification pipeline against the live APIs it depends on.
//   node test-identify.js
// Needs ANTHROPIC_API_KEY (see .env.local). Hits Claude, WoRMS, iNaturalist
// and occasionally GBIF for real, so it costs a few tokens and a few seconds.
//
// app.js is a plain browser script with no exports, so rather than duplicating
// the pipeline here we evaluate the real file against a stub DOM and pull the
// functions out. That means this test breaks if the shipped code breaks, which
// is the entire point.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

for (const line of fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

// Absorbs any DOM call app.js makes at load time.
const stub = new Proxy(function () {}, {
  get: (_, prop) => (prop === "then" ? undefined : stub),
  apply: () => stub,
  set: () => true,
});

const identifyHandler = require("./api/identify.js");
const realFetch = globalThis.fetch;

// Route the app's relative /api/identify call to the real handler in-process.
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("/api/identify")) {
    const req = { method: "POST", body: JSON.parse(options.body) };
    let status = 200;
    let payload;
    const res = {
      status: (c) => ((status = c), res),
      json: (o) => ((payload = o), undefined),
    };
    await identifyHandler(req, res);
    return { ok: status < 400, status, json: async () => payload };
  }
  return realFetch(url, options);
};

const src = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const load = new Function(
  "document", "window", "gsap", "DEPTH_ZONES", "REDUCED_MOTION", "requestAnimationFrame",
  "setReadout", "applyDepthAt", "scrollRush", "startDescent", "settle", "emitBurst", "fetch",
  `${src}\n;return { identifyTaxon, verifyMarine, viaCommonNames, DiveError };`
);
const app = load(
  stub, stub, stub, [{}, {}, {}, {}, {}], true, stub,
  stub, stub, stub, stub, stub, stub, globalThis.fetch
);

const CASES = [
  { prompt: "that spiky orange fish that lives in anemones", expect: /^Amphiprion/ },
  { prompt: "blob with a built-in fishing lure",             expect: /./ },
  { prompt: "huge gentle shark covered in spots",            expect: /^Rhincodon typus$/ },
  { prompt: "seal",                                          expect: /./, notPlant: true },
  { prompt: "clownfsh",                                      expect: /^Amphiprion/ },
];

// Non-marine input must fail cleanly rather than surfacing a land animal.
const REJECT = ["my neighbour's golden retriever", "a red brick"];

(async () => {
  let failures = 0;

  // The regression that started all this: raw iNat search for "seal" is a plant.
  const raw = await realFetch("https://api.inaturalist.org/v1/taxa?q=seal&per_page=1")
    .then((r) => r.json());
  assert.equal(raw.results[0].name, "Ranunculaceae", "iNat's raw ranking changed; revisit the pipeline");
  console.log("baseline: raw ?q=seal still returns Ranunculaceae (a plant) — pipeline is still needed\n");

  for (const { prompt, expect, notPlant } of CASES) {
    try {
      const taxon = await app.identifyTaxon(prompt);
      const ok = expect.test(taxon.name);
      assert.ok(taxon.default_photo, `no photo for "${prompt}"`);
      if (notPlant) assert.notEqual(taxon.name, "Ranunculaceae", "still returning the buttercup family");
      console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(prompt)} -> ${taxon.name} (${taxon.preferred_common_name || "—"})`);
      if (!ok) failures++;
    } catch (err) {
      console.log(`FAIL  ${JSON.stringify(prompt)} threw: ${err.message}`);
      failures++;
    }
  }

  for (const prompt of REJECT) {
    try {
      const taxon = await app.identifyTaxon(prompt);
      console.log(`FAIL  ${JSON.stringify(prompt)} should have been rejected, got ${taxon.name}`);
      failures++;
    } catch (err) {
      const clean = err instanceof app.DiveError;
      console.log(`${clean ? "PASS" : "FAIL"}  ${JSON.stringify(prompt)} rejected: ${err.message}`);
      if (!clean) failures++;
    }
  }

  // Synonym resolution: an outdated binomial must come back as the accepted one.
  const resolved = await app.verifyMarine([{ scientific_name: "Premnas biaculeatus" }]);
  const synOk = resolved[0] === "Amphiprion biaculeatus";
  console.log(`${synOk ? "PASS" : "FAIL"}  synonym Premnas biaculeatus -> ${resolved[0]}`);
  if (!synOk) failures++;

  console.log(failures ? `\n${failures} failing` : "\nall passing");
  process.exit(failures ? 1 : 0);
})();
