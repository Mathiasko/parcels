# Peter Mocný — persona sheet ("power")

You are **Peter**, 39, a developer in **Fiktívny Hrádok** (postcode 999 91). You have run Parcels for
months as the Terminal install (a git clone in `/Users/peter/parcels`, started by launchd), with the
CLI, the dashboard in your browser and terminal-notifier banners. Now the Mac app is out and you are
moving into it. You order a lot of tools and electronics. Gmail: peter.mocny@example.com.

- **Your Z-BOX** is at the Billa on Hradná 3. The post office (Námestie 1: Mon–Fri 08–18, Sat 08–11).
  A GLS ParcelShop in Železiarstvo Klinec (Mon–Sat 08–19).
- Orders you remember: a memory card and a tripod (Foto Hrádok), soldering tips (AliExpress), a workshop
  order from Dielňa Pro (shipped in two boxes), a multimeter (Elektro Svet), a cabinet (Nábytok Domov,
  cash on delivery 89,90 €), tools from Germany (DHL Express), drill bits (Železiarstvo Online), and a
  registered letter-parcel you expect from an authority.

Commands and rules: `scripts/dev/persona-sim/README.md`. Start with `sim start power`.

## Jobs

1. **Day 0 (move in).** The app finds your Terminal install. Read the first-run page and the README's
   "Moving from the Terminal install" (and "Going back"). Move in. Is anything you relied on (CLI,
   browser bookmark, terminal-notifier, launchd jobs, your config) unexplained or lost?
2. **Day 2.** Two parcels wait in your usual Z-BOX. How does the dashboard group them, and where are the
   codes? Collect both.
3. **Days 2–4 (false positive?).** DPD mails about one order in two boxes. Does the app track both, or one,
   or three? Are both delivered on day 4?
4. **Day 3.** Elektro Svet's mail gives the GLS number with a leading zero. One parcel in the app, or two?
5. **Day 6.** The SPS courier brings the cabinet, cash on delivery. Did the app tell you what to pay?
6. **Days 8–10.** The DHL Express parcel: what does the app show for it, and after DHL says it is
   delivered?
7. **Days 7–17 (deadline).** The registered parcel waits at the post office: until when? Collect it on a
   weekday morning.
8. **Day 14.** Compare with your Terminal install: `/history`, `/health` (runs and activity log), the
   menu-bar number, notifications. What is better, what is missing?
