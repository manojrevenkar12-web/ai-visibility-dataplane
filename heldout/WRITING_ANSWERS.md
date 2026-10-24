# Writing held-out AI answers

This set tests how well answers from AI assistants are read: which tracked brands an answer
mentions, in which order, and which web pages it cites. You write the answers and the answer key.
You have not seen the code that reads them, and should not.

## What to write

One file per set: `heldout/<set>/answers.yaml`.

```yaml
projects:
  - id: h1
    category: "Buchhaltungssoftware für Freelancer"     # any market, German or English
    brands:                                            # 5 to 8 tracked brands of that market
      - { id: h1-b1, name: "Lexware Office", aliases: ["Lexoffice"], domains: ["lexware.de"], ambiguous: false }
      - { id: h1-b2, name: "Pilot", aliases: [], domains: ["pilot.com"], ambiguous: true }  # the name is also an ordinary word
answers:
  - id: a001
    project: h1
    provider: chatgpt        # chatgpt | claude | perplexity | gemini | ai_overview
    language: de             # de | en
    text: |                  # the answer as the assistant would show it (markdown allowed)
      ...
    citations:               # the links the assistant attached, exactly as it would print them
      - "https://www.lexware.de/lexoffice/?utm_source=chatgpt.com"
    key:
      mentioned: [h1-b1, h1-b3]                        # tracked brands the answer recommends or names, in order of first mention
      pages: ["https://lexware.de/lexoffice"]          # one entry per distinct page cited (see below)
```

## Rules for the answer key

- **mentioned** lists a brand when the answer refers to that company or product, however it is
  written: the name, an alias, a possessive, a different case, inside a table, in bold. The order
  is the order in which each brand is first mentioned. Do not list a brand whose name only appears
  as an ordinary word ("a pilot project", "the signal is weak"), or only inside a URL.
- **pages** lists each cited page once. Write it as `https://` + host without `www.`/`m.` +
  path without a trailing slash, keeping query parameters that select content (`?id=12`) and
  dropping tracking ones (`utm_*`, `gclid`, `fbclid`, `ref`, `srsltid`) and fragments. Two links
  to the same page count once.

## What to vary

Write 120 answers over 8 projects (about half German, half English). Vary the length, the
structure (numbered lists, tables, prose, headings, bullet lists with bold), and the way brands
are written (aliases, abbreviations, lowercase, possessives, German inflection, names next to
punctuation or emoji). About a quarter of the brands should be ambiguous names. Include cases that
are hard on purpose: an ambiguous name used in both senses in one answer, a brand named only in a
comparison table, a brand mentioned only to say it is *not* recommended (still a mention), a
brand that appears only in a URL (not a mention), sentences that start with an ambiguous brand,
and answers that mention no tracked brand at all. Citations should look like the ones real
assistants attach: tracking parameters, `www.`, mobile hosts, trailing slashes, AMP paths,
fragments, the same page cited twice in different forms.

Do not read anything in this repository except this file.
