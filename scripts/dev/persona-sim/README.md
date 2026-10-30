# Living with Parcels for 14 days: the simulator

You are a person who has just installed **Parcels**, a Mac app that reads your parcel e-mails from Gmail,
tracks the parcels with the carriers, shows a number in the menu bar (parcels ready to collect), sends
notifications and has a dashboard window. This simulator is your Mac, your Gmail and the streets around
your home for 14 days. Your persona sheet is `scripts/dev/persona-sim/scenarios/<you>.md`: who you are,
and the jobs you must try, each tied to a day.

## The one rule

**Know only what the simulator shows you.** Do not read source code, the repository, other files in
this folder, or anything under `scenarios/<you>/` (those are the answers). Your sources are the output of
`sim` commands, the screenshots it makes, and your persona sheet. If something is unclear, that is a
finding: write it down instead of looking it up.

## Commands

Run them from the repository root as `scripts/dev/persona-sim/sim ...` (below: `sim`).

| Command | What it does, and what it prints |
|---|---|
| `sim start <you>` | Starts your simulated Mac on the evening of **day 0** (you just installed the app). Prints the dashboard address. Takes a few seconds. |
| `sim day` | Lives through the rest of today, or the next day if today is over, and prints the **day digest**: the date, the menu-bar number in the morning, at midday and in the evening, every notification (time, title, text, and what clicking it opens), and every new e-mail as Gmail lists it (sender, subject, a preview; `[label: parcels]` if Gmail's filter labelled it). The first `sim day` finishes day 0 and also lives day 1. |
| `sim day --until 07:40` | Same, but stops at that time of the current (or next) day, so you can act then. The next `sim day` finishes that day. |
| `sim status` | Day and time now, menu-bar number, dashboard address. |
| `sim text <page>` | What a page of the app shows: its visible text, then **LINKS** and **FORMS**. Pages: `/` (dashboard), `/history`, `/attention`, `/health`, `/settings`, `/add`, `/parcel/<n>`; `app:first-run` (the page the app opens with on first launch); `readme` (the list of README sections) and `readme:<section>`. |
| `sim post <action> name=value ...` | Submits a form, which is how you click a button (see below). Prints where the window goes next and what it shows, plus any notification that appeared and a changed menu-bar number. |
| `sim shot <page> [--width 1280\|390] [--dark] [--out file.png]` | Screenshot of a page. Prints the PNG path. 1280 is the app window; 390 is a narrow window. Look at the PNG with your image viewer (e.g. the Read tool). |
| `sim mail` / `sim mail <n>` | Your Gmail inbox (everything, not only parcel mail), or e-mail number `n` in full. |
| `sim collect <code or number>` | You go to a pickup point and collect a parcel: the code or PIN for a box, the parcel number at a counter (post office: bring your ID; that is assumed). Prints what happens at the box or counter. Counters have opening hours; on your away days nothing is in reach. |
| `sim stop` | Shuts your Mac down and deletes it. `--keep` keeps its folder (and your screenshots). |

If several personas run at once, add `--as <you>` to every command.

## Clicking

There is no JavaScript anywhere: every button is a form. `sim text` lists each form with a ready line,
already holding the values the form has now:

```
  [form 3] POST /parcel/2/collected   (under "SHEIN")
     field back [hidden] = "home"
     button "Mark as collected"
     → as is, "Mark as collected": sim post /parcel/2/collected back=home
```

Copy that line; to type into a field, change its value (`label='New shoes'`); quote values with spaces.
A field you leave out is sent empty. Where a form has several buttons, use the line for the button you
mean. To follow a link, `sim text <its path>`. Links to other websites (Gmail, Google, Apple Maps,
GitHub) cannot be opened here: note what you would expect to find there. A notification's
"(clicking it opens /parcel/4)" means `sim text /parcel/4`.

Screenshots show what text cannot: layout, colour, what stands out. Take one when you judge how something
looks, at both widths if it matters.

## Time

Everything you do happens at the simulated time now (`sim status`). The app checks for mail and carrier
news on its own schedule during the day; nothing happens at night. To be somewhere at a time of day,
advance to it first: `sim day --until 07:40`, then `sim collect ...`, then `sim day` for the rest.
Picking a parcel up is something you do in the world (`sim collect`); telling the app is a separate act
(Mark as collected), which the app may or may not need. A parcel left too long goes back to the sender.

## Day 0

You have just installed the app. Read what a new user would: `sim text app:first-run`,
`sim text readme:install-the-app`, `sim text /settings` (and its "How to connect Gmail" steps). Submit
the first-run page as you would. You cannot really create an App Password or import the Gmail filter
here; decide whether you **could**, from those pages alone. The first `sim day` treats the setup as done.

## A day, in practice

1. Look at your persona sheet: is there a job today, and at what time?
2. `sim day` (or `sim day --until HH:MM` for a job at a time). Read the digest as the person would.
3. Do what the person would: open the app (`sim text /`), read a mail (`sim mail 12`), go and collect
   (`sim collect ...`), click (`sim post ...`), take a screenshot.
4. Note what you saw, did, expected and felt, in your own words, before moving on.

At the end: `sim stop`.
