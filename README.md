# trilium-fsrs

Spaced-repetition flashcards **inside [TriliumNext](https://github.com/TriliumNext/Trilium)**, scheduled with [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler) (the scheduler Anki uses). Write cards in ordinary notes, study them on a page in Trilium, and keep everything (cards, review history, settings) in your own Trilium database.

- **FSRS-6 scheduling** through [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), fetched fresh on every build
- **Cards written in notes:** `Question :: Answer`, cloze deletions, multi-line cards, images
- **2 or 4 answer buttons** (Forgot / Remembered, or Again / Hard / Good / Easy)
- **Statistics:** streak, retention, review heatmap, card maturity, workload forecast
- **Settings tab:** every scheduling parameter, editable without touching code
- **Load balancer** (always on) modelled on Anki's, so reviews don't pile up on one day
- **Weight optimizer** that fits FSRS to your own review history
- Uses Trilium's theme variables, so it follows your light or dark theme

> **Status:** developed and tested against a simulated Trilium page (jsdom) and simulated learners, not yet against a large real-world Trilium library. Please open an issue if something misbehaves in your install.

## Install

### 1. Allow backend scripts

The review page reads your notes and saves review state through Trilium's backend, which needs backend scripting enabled. For Docker or Podman, add this to the Trilium service:

```yaml
services:
  trilium:
    image: docker.io/triliumnext/trilium:latest
    environment:
      - TRILIUM_SECURITY_BACKEND_SCRIPTING_ENABLED=true
```

Then recreate the container (`docker compose up -d --force-recreate`). Backend scripts run code on the machine hosting Trilium, so only enable this if everyone who can log in to your Trilium is trusted, and use a strong password.

### 2. Import the package

1. Download `trilium-fsrs.zip` from the [latest release](../../releases/latest) (or from the artifacts of a [workflow run](../../actions)).
2. In Trilium, right-click a note in the tree and choose **Import into note**.
3. Pick `trilium-fsrs.zip` and **untick "Safe import"**. With it ticked, Trilium disables the `renderNote` relation and the page will not render.
4. Open the new **Flashcards** note.

You get this tree:

```
Flashcards        render note (the review page) and the folder for everything below
 ├─ Review UI     HTML code note with the styles and page skeleton
 │   └─ review.js JS frontend code note: the app
 ├─ srs-state     JSON code note with your review history and every card's FSRS state
 ├─ srs-settings  JSON code note with your settings
 ├─ ts-fsrs       code note with the ts-fsrs library   (#fcLib=ts-fsrs)
 ├─ optimizer     code note with the weight optimizer  (#fcLib=optimizer)
 └─ About and licenses   text note with the source link and third-party notices
```

Don't rename the labels (`#srsState`, `#srsSettings`, `#fcLib=…`) and don't move the notes out of `Flashcards`. `About and licenses` is only informational and can be deleted.

The helper notes are **archived**, so they stay out of your way: with Trilium's *Hide archived notes* option on (toggle it with **Ctrl+H**) the `Flashcards` note shows no children. Turn the option off to see them, for example to look at `srs-settings` or to edit the code. The scripts still find archived notes.

## Writing cards

Add the label **`#flashcards`** to any text note that holds cards (open the note's *Owned Attributes* tab and type `#flashcards`). Any number of notes can have it.

| You write | You get |
|---|---|
| `What is TCP? :: A transport protocol` | one card (keep the spaces around `::`) |
| `The capital of {{c1::France}} is {{c2::Paris::city}}` | two cloze cards; the second shows the hint `[city]` |
| three paragraphs: `Q`, then `::`, then `A` | one card, question and answer each one paragraph |
| several paragraphs, a line with only `?`, then more paragraphs, ended by a horizontal line or a heading | one card with a multi-paragraph question and answer |

Details:

- Text, bold, lists, code and **images** all work on both sides of a card. Use Trilium's own formatting.
- Lines separated by Shift+Enter count as separate lines.
- Code blocks are ignored, and so is `::` inside inline code (`` `std::vector` `` is safe). `C++ ::` at the end of a line is not a card either.
- A sentence with ` :: ` in the middle of it **is** read as a card. Keep prose that contains ` :: ` in notes without `#flashcards`.
- A card is identified by the text of its question. If you edit the question, it becomes a new card and starts from scratch.
- Cloze cards from one line are *siblings*; the scheduler keeps them apart (see [Load balancer](#load-balancer)).

## Studying

Open **Flashcards**. The top bar shows three counts, like Anki: new (blue), learning (red) and due for review (green); the current card's kind is underlined. Click the note title to jump to the card's source note.

| Key | Action |
|---|---|
| `Space` | show the answer; after that, grade **Good** |
| `1`, `2` (`3`, `4` with 4 buttons) | grade the card (see below) |

**2 buttons** (default): `1` Forgot, `2` Remembered. Forgot is FSRS *Again*; Remembered is *Good*.

**4 buttons:** `1` Again, `2` Hard, `3` Good, `4` Easy. Each button shows the interval it would give. Use Hard when you recalled it but only after a struggle, Easy when it was instant, and Again when you could not recall it or got it wrong. Most reviews should be Good; consistency matters more than precision. Switch any time in *Settings → Answer buttons*.

## Statistics

The **Statistics** tab shows: reviews and time today, current streak, 30-day retention, total cards, a one-year review heatmap, card maturity (new / learning / young under 21 days / mature), reviews of the last 30 days split into remembered and forgotten, and how many cards fall due over the next 30 days.

## Settings

The **Settings** tab keeps everything in the `srs-settings` note; no code editing needed. Changes are saved automatically as soon as you leave a field or pick an option, and an invalid value is reported instead of saved. *Restore defaults* resets everything.

| Setting | Default | Meaning |
|---|---|---|
| Buttons | 2 | 2 (Forgot / Remembered) or 4 (Again / Hard / Good / Easy) |
| New cards per day | 20 | unseen cards introduced each day |
| Maximum reviews per day | 0 | 0 = no limit |
| Desired retention | 0.90 | chance of remembering a card when it comes due (0.70 – 0.99); higher means more reviews |
| Maximum interval | 36500 | days |
| Learning steps | `1m 10m` | delays for a new card |
| Relearning steps | `10m` | delays after forgetting a review card |
| FSRS weights | empty | 21 numbers; empty uses the defaults |

FSRS's own guidance is to keep learning and relearning steps short enough to finish on the same day (a single step such as `10m` is the documented good case, and `1d` steps are discouraged).

## Load balancer

The load balancer is always on. It moves each newly scheduled review inside its normal fuzz range (about ±15% for short intervals down to ±5% beyond 20 days) to a quieter day. It follows the logic of Anki's built-in load balancer:

- picks a day at random with weight `(1 / cards due)^2.15 × (1 / interval)^3` (an empty day has weight 1), so quiet and slightly earlier days are favoured
- avoids days near other cloze cards from the same line
- leaves intervals over 90 days to plain fuzz
- never makes an interval shorter than the previous one when that fits inside the fuzz range

In a deck simulation (800 cards, 300 days, 6 seeds) it cut the day-to-day spread of reviews from 7.8 to 4.5 and the peak day from 33 to 25, with retention unchanged. It is a port, not Anki's code running, so expect small differences.

## Optimizing the weights

FSRS ships with default weights fitted to many learners. **Settings → Optimize weights** fits them to *your* history. It unlocks at **1000 usable reviews** (reviews of a card at least one day after its previous review), and only runs when you press the button.

How it works: it follows the training procedure of the official FSRS-6 optimizer (`fsrs-rs`): pretraining of the initial stabilities, outlier filtering, Adam with a cosine learning-rate schedule, recency weighting and an L2 pull toward the initial weights. To decide whether the result is worth using, it runs **5-fold cross-validation**: every card is held out once, and the new weights are only offered if they predict those held-out reviews better than your current weights by at least 1.5 standard errors. **Use these weights** then saves them as your FSRS weights.

Good to know:

- Gradients come from finite differences, not the analytic ones the official optimizer uses, so results are close but not identical.
- On simulated learners it matched the official optimizer's held-out log loss to within about 0.002, but it has not been compared on real review data.
- Gains are often small. Expect "not clearly better" fairly often, especially with fewer than a few thousand reviews.
- Hard and Easy weights (`w1`, `w3`, `w15`, `w16`) stay put until you have at least 30 relevant reviews.
- Before each run the optimizer checks its memory model against the installed ts-fsrs and refuses to run if they disagree.

## Your data

Everything is in two JSON notes. `srs-state` holds `cards` (the FSRS state of each card) and `logs` (every review: card, time, grade, previous state, seconds taken). `srs-settings` holds your settings. Keeping them apart means a reset or restore of one doesn't touch the other. Nothing leaves your Trilium. Back it up like any other note, and note that its revisions are disabled (`#disableVersioning`) because it changes on every review.

## Updating

Importing the zip again creates a second `Flashcards` tree with empty `srs-state` and `srs-settings` notes. To keep your history and settings, copy the content of your old `srs-state` and `srs-settings` notes into the new ones, then delete the old tree. (If you only copy `srs-state` from a version before 1.0.2, its settings are moved into `srs-settings` automatically the first time you open the page.) Alternatively, replace only the notes that changed (`review.js`, `Review UI`, `optimizer`); `review.js` and `optimizer` should always be updated together. Without an `srs-settings` note the page simply keeps storing settings in `srs-state`, as older versions did.

## Building from source

Requirements: Python 3 and network access (the build downloads the latest `ts-fsrs` UMD bundle from jsDelivr).

```bash
python3 build.py            # fetch the latest ts-fsrs and write trilium-fsrs.zip
python3 build.py --offline  # reuse the cached src/ts-fsrs.js
```

`build.py` writes a Trilium ZIP export (`!!!meta.json` format 2) with fixed note IDs, the labels, and the `~renderNote` relation already set. To add another external library, add it to `PACKAGES` in `build.py` and give it a `#fcLib` note.

Layout:

```
src/review.js       the app (parser, FSRS scheduling, load balancer, review/statistics/settings UI)
src/review-ui.html  page skeleton and CSS (uses Trilium theme variables)
src/optimizer.js    FSRS-6 weight optimizer
src/srs-state.json  empty state
build.py            builds the importable zip
tests/              checks that run in CI
```

### CI

`.github/workflows/build.yml` builds the package on every push and pull request, checks that the optimizer's memory model still matches the freshly fetched ts-fsrs, verifies the archive layout, and uploads `trilium-fsrs.zip` as a workflow artifact. Pushing a tag such as `v1.0.0` also publishes it as a GitHub release.

## Credits

- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT), bundled into the package at build time.
- The FSRS algorithm and the official optimizer, [fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs) (BSD-3-Clause): the weight optimizer is a JavaScript re-implementation of its FSRS-6 training procedure.
- [Anki](https://github.com/ankitects/anki) (AGPL-3.0-or-later): the load balancer, fuzz ranges and sibling handling are ported from its scheduler.

The full notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and inside the package.

## License

Copyright (C) 2026 dnx04. Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). This matches the license of the Anki scheduler code the load balancer is ported from.

In short: you may use, study, modify and share this project, but if you distribute a modified version, or let others use one over a network, you must make the corresponding source available under the same license (see section 13 of the license). Third-party components keep their own licenses, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
