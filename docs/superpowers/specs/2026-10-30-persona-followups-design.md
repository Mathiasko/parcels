# Persona follow-ups: pickup codes, quieter notifications, setup wording, Czech mail and PPL

Date: 2026-10-30. Source: `scripts/dev/persona-sim/results/CONSOLIDATED.md` (items C1, B1, §4 setup
funnel, C5). Approved in chat the same day. Cash-on-delivery (C2) is deliberately out: the owner never
pays on delivery.

Branch `persona-followups`, worktree `/Users/matuslaco/Desktop/parcels-mac-app`. The live install is
`/Applications/Parcels.app` on 8787 and the checkout `/Users/matuslaco/Desktop/parcels`; neither is
touched until the owner merges.

## Goal

Close the four gaps that kept the test personas in Gmail or annoyed them:

1. a PIN or code for every carrier's pickup, not only the Packeta Z-BOX;
2. far fewer notifications, with three switches;
3. setup copy a non-technical friend can follow alone;
4. Czech mail: Zásilkovna visible, PPL tracked.

Success: each part's tests below pass, the fake-mail harness and persona scenarios show no new
mismatch, and a re-run of the affected persona jobs (zuzana, petra, eva, lucia, jan) no longer hits the
cited moments.

## 1. Pickup PINs and codes for every carrier

**Today.** `PICKUP_CODE` (`src/ingest/extract.ts`) matches only "Kód pre/pro otvorenie/otevření
schránky". `runPickupCodes` (`src/core/pickup-code.ts`) reads each ready parcel's stored mail, newest
first, and records the first code in `pickup_codes`. `checked_messages` is a watermark: a parcel whose
mail count has not grown is never re-read.

**Change.**

- `extractPickupCode(text)` keeps its signature but tries a list of labelled patterns. Every pattern
  requires a label immediately before the code, then 4-10 digits (spaces inside allowed, as today), not
  followed by another digit:
  - Packeta Z-BOX, SK and CZ: the existing pattern;
  - "PIN kód", "PIN kod", "PIN" followed by `:` or "na otvorenie schránky" / "pro otevření" (GLS BOX and
    ParcelShop, pošta BalíkoBOX, DPD Pickup Station, PPL ParcelShop and Parcelbox);
  - "verifikačný kód" / "overovací kód" (SPS Balíkovo);
  - DPD's own phrasing, taken from `test/fixtures/fake-mail/43-*.eml` and `test/fixtures/mail/dpd-pickup-station.eml`.
  
  A match on a line that also says telefón/tel/phone/objednávka/order (the existing `NOT_TRACKING`
  vocabulary) is refused. The first pattern that matches wins; the order is most specific first.
- **Wording on the card**, in `pickupCodeLine(code, kind)` (`src/web/views/index.ts`), from the parcel's
  pickup `kind`:
  - `zbox`, `locker`: "Open the box with **631285**";
  - `parcelshop`, `post_office`: "Show this PIN at the counter: **402211**";
  - `unknown` or no pickup: "PIN **402211**".
- **Rescan.** A migration sets `checked_messages = -1` on every `pickup_codes` row whose `code IS NULL`,
  so parcels already waiting are read once with the new patterns. Rows with a code are untouched.
- Codes stay out of notification banners (lock screen), as today.
- The run log and support bundle already count codes found; `PickupCodeReport.found`'s comment loses
  "Z-BOX".
- README "The Z-BOX opening code" becomes "Pickup codes and PINs".

**Tests.** Positive cases from fixtures 20 (GLS BOX), 43 (DPD station), 44 (pošta BalíkoBOX), 28 (SPS
Balíkovo), `mail/gls-ready-for-pickup.eml`, `mail/dpd-pickup-station.eml`, the Z-BOX fixtures (leading
zero kept), and a new PPL ParcelShop sample. Negative cases: a phone number after "PIN"-free text, a
tracking number, an order number, "PIN" in a promo mail with no digits after it, a 3-digit and an
11-digit run. The rescan migration: a NULL row is re-read, a found row is not. The card wording, one test
per kind.

## 2. Notifications: quiet defaults and three switches

**Today** (`src/notify/rules.ts`, `nudge.ts`): every status transition gets a banner; a ready parcel is
nudged at 08:00 and 15:30; "Delivered" fires even after the user's own mark; there are no settings.

**Change.**

- **Config.** `config.json` gains an optional object, defaults applied when absent or partial:
  ```json
  "notifications": { "progress": false, "dailyReminder": true, "delivered": true }
  ```
  Validated in `src/core/config.ts` like `notifier` (booleans only, unknown keys rejected).
- **Settings.** A "Notifications" block with three checkboxes, saved with the rest of the form:
  - "Registered and in-transit updates" (`progress`);
  - "A daily reminder while a parcel waits for you" (`dailyReminder`);
  - "Delivered" (`delivered`).
- **Rules.**
  - A transition to `pre_transit` or `in_transit` is announced only when `progress` is on. It is
    still recorded with `markAnnounced` either way, so switching it on later does not release a
    backlog.
  - A transition to `delivered` is silent when `delivered` is off, or when the parcel has a
    `user_marks` row (the user already said they have it). Also still recorded.
  - Everything else is unchanged: ready, out for delivery, failed attempt, problem, returning,
    returned, a new pickup point, the 48 h deadline warning, carrier/ingest/poller/update alarms, and
    the summary above four updates.
- **Reminder.**
  - `NUDGE_SLOTS` becomes 08:00 only.
  - No reminder on the Bratislava calendar day the parcel became ready (`lastChangedAt`); the ready
    banner said it.
  - Nothing when `dailyReminder` is off. The slot is still marked, so switching it on mid-morning
    does not fire a late one.
  - Headline "Still waiting since Tue" (weekday of `lastChangedAt`; "since 3 Nov" when older than six
    days) instead of "· day N".
  - The message ends with "Collected it? Mark it in the app to stop these."
- README "Notifications" and "Reminders while a parcel is waiting" rewritten to match.

**Tests.** Each switch on and off; progress off records the announcement; delivered silenced by a
user mark; no reminder on the ready day, one on the next day at 08:00 and none at 15:30; the new
headline and message; config validation (missing object, partial object, wrong type, unknown key).

## 3. Simpler setup wording (English only)

**Change** (copy and small layout, `src/web/views/settings.ts`, `app/pages/welcome.html`, README):

- **The guide** becomes three numbered groups with plain headings and honest timing ("about ten
  minutes, on three Google pages"):
  1. Label your parcel mail in Gmail;
  2. Make an App Password;
  3. Paste it here.
- **Jargon** is explained at first use: a filter is "a Gmail rule that files mail under a label"; IMAP
  is "the way apps like this one read mail".
- **Show in IMAP** is in bold in step 1 and repeated in the label field's hint.
- **The App Password sentence tells the truth:** "An App Password can read and send mail as your whole
  account. Parcels only reads the `parcels` label and never sends mail. You can revoke it any time at
  myaccount.google.com/apppasswords." "16-character" stays; "Spaces are fine" is added.
- **Two lines for other setups:**
  - "Company (Google Workspace) accounts work too; your admin may have to allow App Passwords."
  - For sellers: "Sell online? Add `-from:yourshop.sk` to the filter so your customers' dispatch copies are
    not tracked as your parcels."
- **After a successful save,** the result says when parcels will appear: "Your parcels appear at the
  next check (21:00) — or press Refresh now." The time is the next scheduled poll, from the same
  schedule the dashboard uses.
- **A way out:** "Skip for now — add a parcel by hand" under the guide, linking to `/add`, shown while
  Gmail is not connected.
- **Welcome page:** "Next, Settings shows how to connect your Gmail" becomes "Next: connect Gmail (about
  ten minutes), or skip it and add parcels by hand."
- **README:** "Install the app" matches the new wording, and a new **Uninstalling** section explains:
  1. quit Parcels from the menu bar;
  2. trash the app;
  3. delete `~/Library/Application Support/Parcels` and `~/Library/Logs/Parcels`;
  4. revoke the App Password;
  5. delete the Gmail filter and the `parcels` label.

Out: translation, notarising, a printable one-pager.

**Tests.** The existing settings view tests updated to the new copy; a test that the skip link shows
only while IMAP is unset; a test for the next-check sentence after a successful save.

## 4. Czech mail: Zásilkovna and PPL

### 4a. Gmail filter and Zásilkovna

- **The filter** (`gmail-filter.xml`):
  - `zasilkovna.cz` and `ppl.cz` join the carrier `from:` list;
  - both subject lists gain zasilka, zasilku, zasilky, pripravena, vyzvednuti, "k vyzvednuti",
    "vydejni misto", "vydejnim miste", dorucime;
  - the comment gains the sellers' `-from:` tip.
- **Telling existing users.** Gmail does not update an imported filter, so a one-line notice on
  Settings and in the release notes says: "Set up before <version>? Import the filter again and delete
  the old one, so Czech mail is labelled too." Config gains `filterVersion` (absent means 1; this
  filter is 2). The notice shows when Gmail is connected and `filterVersion` is below 2. Its button
  "Done, I imported it again" sets 2. Downloading `/gmail-filter.xml` sets 2 as well, so a new setup
  never sees the notice.
- **Zásilkovna mail.** `zasilkovna.cz` already maps to Packeta. New fixtures:
  - Czech "accepted" ("Zásilka … byla podána" / "přijata");
  - "ready" ("Zásilka je připravena k vyzvednutí", with a Z-BOX line "Kód pro otevření schránky");
  - "picked up" ("vyzvednuta");
  - "returning".
  
  Each is modelled on the shape of the existing CZ fixtures 31 and 62. Any phrasing the extractor
  misses is fixed in `extract.ts`.

### 4b. PPL as a carrier

- **Carrier id** `ppl` and display name "PPL" are added everywhere `CarrierId` is enumerated (types,
  `CARRIER_NAME`, registry, health, glyphs, add page picker, support bundle).
- **Adapter** `src/carriers/ppl.ts`:
  ```
  POST https://api.dhl.com/ecs/ppl/webapi/TrackAndTrace/<number>
  dhl-api-key: <the key PPL's public site uses>
  Content-Type: application/json
  body: {}
  ```
  - **Not found:** a 400 whose body has `detail: "service.TrackAndTrace.ShipmentNotFound"` is the
    adapter's "no such parcel" answer. Any other 4xx/5xx or an unreadable body is a failure, which
    Health reports as it does for the other carriers.
  - **Status** comes from the codes, never from the text: `phase` / `lastEventCode` / each event's
    `code`. The mapping:

    | PPL code | Canonical status |
    |---|---|
    | `WaitingForShipment` | `pre_transit` |
    | `PickedUpFromSender`, `ShipmentInTransport`, `PreparingForDelivery` | `in_transit` |
    | `LoadingForDelivery`, `OutForDelivery` | `out_for_delivery` |
    | `DeliveredToPickupPoint`, `Delivered.Parcelshop` | `ready_for_pickup` |
    | `Delivered` | `delivered` |
    | `NotDelivered` | `failed_attempt` |
    | `BackToSender` | `returning` |
    | anything else | `unknown` |

    The event text is kept as the event description, in whatever language it arrives.
  - **Pickup point:** `accessPoint.parcelshopName` becomes the pickup name; the kind is `parcelshop`,
    or `locker` when the name says Parcelbox.
  - **Retained till:** none from the API. Pickup deadlines come from mail, as for other carriers.
  - The adapter is written against the response shape documented by the open-source
    `ha-parcel-integrations/ha-ppl-cz` integration and the not-found probe of 2026-10-30. Its file
    comment and the README say it is **not yet checked against a real parcel**.
- **Recognising a PPL number:** 11 digits, the same shape as GLS. So:
  - **in mail:** taken as PPL only when the sender is `ppl.cz` (`SENDER_DOMAINS`, and `ppl` in
    `BRAND_DOMAIN`'s look-alike rule), or when "PPL" is named within the same sentence as the labelled
    number (`namedBareNumbers`);
  - **by shape alone:** never;
  - **on Add:** PPL is in the carrier picker; "Detect from number" never returns PPL;
  - the `DISTINCTIVE` shapes are not changed.
- **README:** a PPL row in the carrier table, and a "Czech mail" paragraph.

**Tests.**
- **Adapter** (fetch stubbed, no network): one mapping test per code; not-found; an unknown code; a
  ParcelShop answer becoming a pickup point; a 500 and an HTML body as failures.
- **Extraction:** a PPL mail from `ppl.cz` with a number; the same number from a stranger with no "PPL"
  is not PPL; an e-shop dispatch naming PPL next to a labelled number is PPL; a GLS mail's 11 digits
  stay GLS; Detect on 11 digits stays GLS.
- **Codes:** the PPL PIN pattern (part 1).
- **Filter:** a test that the filter XML parses and contains the new domains and words.

## Out of scope

Cash-on-delivery, Česká pošta, Slovak/Czech UI, notarising, grouping banners per place, choosing the
reminder hour, the email-only DHL banner, the "not mine" sender rule.

## Rules carried over

- No test touches the network, `~/Library`, `launchctl`, `osascript`, `codesign` or port 8787.
- Nothing reads `config.json` or `data/` of either real install.
- Files are added to git by name.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No merge, push or release without the owner.
