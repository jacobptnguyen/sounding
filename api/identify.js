// Stage 1 of identification: recall, not precision.
//
// Claude proposes several candidate species; it deliberately does NOT get the
// final say. The client validates every candidate against WoRMS (the marine
// register) before anything reaches the screen, so a confident wrong guess here
// is cheap — it just fails validation and the next candidate is tried.
const SYSTEM_PROMPT = `You identify MARINE animals from casual, vague, or misspelled descriptions.

Return up to 5 candidate species, most likely first. Rules:
- Prefer species-level binomials. A genus or family name is a weak candidate: include
  it only after the species guesses, never as the first one.
- Every candidate must be an animal that lives in the sea. Never propose a land or
  freshwater animal, even if the description sounds like one.
- Spelling matters less than coverage: a near-miss binomial is fine, it gets corrected
  downstream. Casting a slightly wider net beats being precise about one guess.
- If the description doesn't describe a marine animal at all, or you genuinely cannot
  guess, return an empty candidates array. Do not invent a plausible-sounding species.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scientific_name", "common_name"],
        properties: {
          scientific_name: { type: "string" },
          common_name: { type: "string" },
        },
      },
    },
  },
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const prompt = (req.body && req.body.prompt || "").trim();
  if (!prompt) {
    res.status(400).json({ error: "Missing prompt" });
    return;
  }

  // Every call here costs tokens, so don't forward an arbitrarily long body to
  // the model. Descriptions of an animal are short; 200 characters is roomy.
  if (prompt.length > 200) {
    res.status(400).json({ error: "That description is too long — try a shorter one." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });
    return;
  }

  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        // Guarantees schema-valid JSON, so no markdown fences to strip.
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach Claude" });
    return;
  }

  if (!claudeRes.ok) {
    res.status(502).json({ error: "Claude request failed" });
    return;
  }

  const data = await claudeRes.json();

  // Schema-valid output is still truncatable, and a refusal isn't JSON at all.
  if (data.stop_reason === "max_tokens" || data.stop_reason === "refusal") {
    res.status(502).json({ error: "Couldn’t read that description. Try rewording it." });
    return;
  }

  let candidates;
  try {
    candidates = JSON.parse(data.content[0].text).candidates;
  } catch (err) {
    candidates = null;
  }

  if (!Array.isArray(candidates)) {
    res.status(502).json({ error: "Couldn’t read that description. Try rewording it." });
    return;
  }

  res.status(200).json({ candidates: candidates.slice(0, 5) });
};
