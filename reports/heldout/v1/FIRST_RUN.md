# Held-out answers v1: first run

Run once on 2026-10-24T08:46:41.184Z. The 120 answers and their answer key were written by an agent that read only
`heldout/WRITING_ANSWERS.md`, never the code. This file is not regenerated; later runs go to `latest.json`.

- Brand mentions: precision **100.0%**, recall **98.5%** (332 found, 0 false, 5 missed); order of first mention exact in 99.0% of answers with two or more brands found.
- Cited pages: precision **98.3%**, recall **98.3%** (228 found, 4 extra, 4 missed).

| Language | Found | False | Missed |
|---|---|---|---|
| de | 161 | 0 | 1 |
| en | 171 | 0 | 4 |

## Errors

- a007 (claude, en): missed h1-b4;
- a016 (chatgpt, en): missed h2-b5;
- a018 (perplexity, en): pages missed https://forbes.com/advisor/business/software/best-project-management-software/amp; pages extra https://forbes.com/advisor/business/software/best-project-management-software
- a028 (perplexity, de): pages missed https://t3n.de/news/projektmanagement-tools-agenturen-vergleich-1612345/amp; pages extra https://t3n.de/news/projektmanagement-tools-agenturen-vergleich-1612345
- a043 (perplexity, de): pages missed https://ebike-news.de/drehmoment-erklaert/amp; pages extra https://ebike-news.de/drehmoment-erklaert
- a047 (claude, en): missed h4-b4;
- a066 (chatgpt, de): missed h5-b1;
- a077 (claude, en): missed h6-b1;
- a078 (perplexity, de): pages missed https://runnersworld.de/laufschuhe/stabilitaetsschuhe-test/amp; pages extra https://runnersworld.de/laufschuhe/stabilitaetsschuhe-test
- a089 (gemini, en): order h6-b2 > h6-b3 > h6-b1 (want h6-b3 > h6-b1 > h6-b2);
