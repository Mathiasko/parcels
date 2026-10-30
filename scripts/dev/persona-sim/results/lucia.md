# Persona test: lucia (Lucia Vymyslená, Brno), 14 days

Note on method: I wrote this after the run, not day by day. The diary below is reconstructed from the digests and my command log. Assumption, because the sheet doesn't say: I have no carrier apps and check parcels through Gmail search.

## 1. Who I am

I'm Lucia, 21, a Slovak student who lives in Brno, and I think in Czech. Most of my mail is Czech, and Slovak wording looks slightly foreign to me.
I use my Mac irregularly and I'm lazy about setup, but I can follow a page if it's clear.

## 2. Diary

**Day 0 (Sun 1 Nov, evening).** The first-run page is in English: "Welcome to Parcels… First, the postcode some carriers ask for." I entered 60200 (Brno), not the 81101 default, which is a Bratislava code. The sim then reported "Setup finished (simulated)" at 20:30. That was the sim, not me. I opened the Gmail filter file and checked it against my mail: it covers Packeta, Slovenská pošta, GLS, DPD and DHL, but not PPL or Česká pošta. Its subject words are mostly Slovak ("zasielka", "odoslana", "vyzdvihnutie", "podacie cislo"). "Zásilka" and "připravena" in Czech don't match, and "zasilkovna.cz" isn't a sender in it.

**Day 1 (Mon 2 Nov).** Nothing happened and I didn't open the app. The digest showed no mail and no notifications.

**Day 2 (Tue 3 Nov).** The bookshop mail (Czech, labelled "parcels") arrived at 10:00. At 15:00 a notification came: "Registered — Knihkupectví Příkladné / Zásilka byla podána." I opened the dashboard once. It says "1 in flight. Nothing needs you." The English heading "Registered" sits over the Czech line "Zásilka byla podána", which is fine for me. The Zásilkovna mail that says the parcel is on its way came at 15:08 and is not labelled.

**Day 3 (Wed 4 Nov).** I didn't open the app. At 07:00 there was a notification "In transit"; at 20:00 the Elektro Brno charger mail arrived, labelled "parcels".

**Day 4 (Thu 5 Nov).** Morning: PPL mail at 07:40 saying the charger arrives today between 10:00 and 13:00. The notification "Ready for pickup — Knihkupectví Příkladné" came at 10:00, four minutes before the Czech Zásilkovna mail at 10:04. The pickup address was in the notification. At 22:00 I went to /attention, where the charger was waiting: "no tracking number found in this message (it contains something shaped like a tracking number)". The carrier list has no PPL. I chose Detect, and the parcel was created as "GLS · 40777777701" with "No updates yet". It has nothing from the carrier. The PPL mail saying "byla doručena" (delivered) at 11:50 never reached the app. I also never saw a notification about it.

**Day 5 (Fri 6 Nov).** I didn't open the app. Notifications: "In transit — Móda Bratislava" and the textbook reminder "Still waiting for you · day 2", twice a day. A Vinted mail (labelled) about the winter jacket came at 18:30.

**Day 6 (Sat 7 Nov).** I didn't open the app. Notification at 10:00 "Registered — Vinted", which is the jacket. The Kosmetika Bella Zásilkovna mail at 14:08 was not labelled, so the app never showed it.

**Day 7 (Sun 8 Nov).** Notification at 10:00: "Ready for pickup — Móda Bratislava / Z-BOX Brno, Smyšlená 12 (Albert)". The collection code (664210) is only in the Zásilkovna mail, not on the parcel page. I collected it at 22:00 with `sim collect`. The app still counted two ready parcels, so I clicked "Mark as collected", and the menu-bar number dropped to 1.

**Day 8 (Mon 9 Nov).** The Zásilkovna mail at 11:04 said a parcel from Kosmetika Bella was ready at the Trafika. I didn't order cosmetics. The mail itself isn't a clear scam signal: it's a Packeta number, says "Zaplaceno" and names a pickup point I know. Still, I didn't trust it. Attention said "Nothing waiting".

**Day 9 (Tue 10 Nov).** Klára's mail at 13:15 confirmed it: she ordered cosmetics with my address by mistake and asked me to collect them for her, because she's in Olomouc until Friday. The app had never tracked the cosmetics parcel. I added it by hand on /add with Z7777777704 and Packeta, and it started showing "carrier says: Zásilka je připravena k vyzvednutí na výdejním místě". The Vinted Z-BOX mail came at 08:44 with the code 307714. The 10:00 notification said "Ready for pickup — Vinted".

**Day 10 (Wed 11 Nov).** At 07:00 the app sent "Pickup deadline approaching — Knihkupectví Příkladné". The Trafika counter opens 08:00 to 19:00, so I went at 08:30. The textbook and Klára's parcel were both handed over with the parcel numbers. I marked both as collected in the app. I collected the Vinted jacket from the Z-BOX with 307714, and marked that as collected too. I also deleted the wrong "Nabíječka" (GLS) parcel, since no carrier was ever going to update it. Sportovní Brno shoes (GLS) were registered at 17:00 from a labelled shop mail, with the Slovak line "Údaje o balíku boli zaregistrované".

**Day 11 (Thu 12 Nov).** No mail, no reminders. The textbook was already collected.

**Day 12 (Fri 13 Nov).** GLS notifications: "Out for delivery — Sportovní Brno", then "Delivered — Sportovní Brno / Balík bol doručený" at 13:00. The parcel left the in-flight list. Vinted sent a separate mail: "Nezapomeň potvrdit, že je vše v pořádku". The app doesn't handle that, and it isn't its job, but I was confused by it.

**Day 13 (Sat 14 Nov).** Nothing. No mail and no notifications.

**Day 14 (Sun 15 Nov).** I checked History and the Health page, and then the full inbox against the app. History shows five finished parcels, four collected and one delivered. Health lists five carriers: Slovenská pošta, Packeta, GLS, SPS and DPD, plus DHL "by email". There is no PPL and no Česká pošta. Mail the app never showed me: both PPL charger mails, the Kosmetika Bella mails and Klára's mail (I only learned about the cosmetics from her). The Zásilkovna mails are all unlabelled, which means the app learns from shop mails and never from Zásilkovna directly. Also at 390 px the menu reads "Parcels / In flight / History / Attention / Health / Settings / Add parcel" across two lines, which is legible but cramped.

## 3. Jobs

**Job 1. Day 0: set up the app.** *Partly.* I could finish it, but only with effort. The steps are clear and mostly in English, which is fine. The gaps I'd hit:
- The first-run page says "Welcome to Parcels" and asks for a postcode with the note "GLS and DPD need it". The default in Settings is 81101, which is Slovak. The first-run postcode did carry over: Settings shows 60200 at the end.
- Settings → "How to connect Gmail": "Make an App Password" and "[2-Step Verification] has to be on" assume my Google account is in English and that I know what App Passwords are. My address is lucia.vymyslena@example.cz, not a gmail.com address, and the form says "Gmail address" with the placeholder "you@gmail.com". I couldn't tell whether a non-gmail.com address works. That's a question, not a verdict.
- The filter: the file says "Gmail ignores diacritics (odoslana matches odoslaná) but does not stem, so the word forms are listed one by one". For Czech mail, "zásilka", "připravena", "vyzvednutí" and "doručena" aren't in the list. The Czech carriers PPL and Česká pošta aren't in the sender list at all. The filter is written for Slovakia.
- I didn't create the App Password or import the filter here. The sim treats setup as finished at 20:30.

**Job 2. Days 2–4: the textbook is on its way.** *Succeeded.* The app registered it on day 2 from the shop's mail and said "Ready for pickup" at 10:00 on day 4, with the Trafika address. That came four minutes before the Zásilkovna mail. Steps: 1 `sim day` (digest), 1 `sim text /` (dashboard), 1 screenshot. I hesitated at the English labels ("Registered", "Ready for pickup") next to the Czech carrier line. The parcel is named after the shop, not the book, and I didn't rename it.

**Job 3. Day 4: the PPL charger.** *Failed.* Quoting what confused me:
- /attention: "no tracking number found in this message (it contains something shaped like a tracking number)". I had to read that twice.
- The carrier list in "Assign to a parcel": "posta (Slovenská pošta) | packeta (Packeta) | gls (GLS) | sps (SPS) | dpd (DPD) | dhl (DHL)". There's no PPL.
- Detect created it as "GLS · 40777777701". After refresh it said "No updates yet / Nothing from the carrier yet."
- The PPL mails ("Dnes vám doručíme zásilku 40777777701", then "byla doručena") never produced a notification or a parcel.
- Steps: 2 `sim text`, 1 `sim post` (assign), 1 `sim post` (refresh), 1 `sim text`. I deleted the wrong parcel on day 10.

**Job 4. Day 7: the sweater from the Z-BOX.** *Succeeded, with friction.* The code 664210 is only in the Zásilkovna mail #14, not on the app's parcel page. The notification at 10:00 gave the address, not the code. I collected it at 22:00 with `sim collect 664210`. The app still said "2 ready for pickup" until I clicked "Mark as collected". Steps: 1 `sim mail 14`, 1 `sim text /parcel/2`, 1 `sim collect`, 1 `sim text /`, 1 `sim post /parcel/2/collected`. Total 5.

**Job 5. Days 8–9: the unknown Kosmetika Bella parcel.** *Partly.* It's real: Klára confirmed it. But the app never tracked it. The Zásilkovna mails about it were not labelled, and the Attention page said "Nothing waiting". I could only get it into the app by hand on /add, using the number from the mail (Z7777777704). The new parcel then said "carrier says: Zásilka je připravena k vyzvednutí na výdejním místě", so the carrier side worked once it was added. Collecting it for Klára meant going to the counter with the number, which worked. Steps: 2 `sim mail`, 1 `sim text /attention`, 1 `sim text /add`, 1 `sim post /add`, 1 refresh, 1 `sim collect`, 1 `sim post /parcel/5/collected`. Total 8.

**Job 6. Day 10: the textbook's pickup deadline.** *Succeeded.* At 07:00 the app sent "Pickup deadline approaching", and I collected at 08:30 at the Trafika with `sim collect Z7777777701`. Steps: 1 notification check, 1 `sim collect`, 1 `sim post /parcel/1/collected`. The notification is correct, but the reminders before it were noise: "Still waiting for you · day 2 … day 7", twice a day. That's annoying, not wrong.

**Job 7. Day 9 or later: the Vinted jacket.** *Succeeded.* The app noticed it on day 6 as "Registered — Vinted" and told me on day 9 that it was ready at the Z-BOX, collect by 17 Nov. The code 307714 is only in the mail. Steps: 1 `sim mail 17`, 1 `sim collect 307714`, 1 `sim post /parcel/4/collected`. The name is "Vinted", not the jacket, and I didn't change it.

**Job 8. Day 14: anything the app never showed me.** *Partly.* Yes, several things. See Problems and Missing features.

## 4. Problems

**The app did something wrong**

1. **Day 4, 22:00, /attention and the carrier list: the PPL charger can't be tracked.** The carrier list has no PPL, Detect assigned it as GLS, and the parcel shows "No updates yet" forever. Severity: **major**. It cost me a parcel I was expecting, and I lost trust that the app would show it.
2. **Day 4, 07:40 to 11:50: the two PPL mails never reached the app.** The PPL sender isn't in the Gmail filter and the subjects aren't matched. The app stayed silent through a delivery. Severity: **major**.
3. **Day 6, 14:08 and day 8, 11:04: the Zásilkovna mails for the Kosmetika parcel are not labelled "parcels".** The filter has `from:packeta.com` but not `zasilkovna.cz`, so the app never saw the parcel. /attention said "Nothing waiting" on day 9. Severity: **major**. Klára's mail was the only reason I found out.
4. **Day 7, 22:00: the sweater was collected, but the app still counted it as ready.** The app only learns about a collection when I click "Mark as collected". Severity: **minor**. I might have assumed it worked.
5. **Day 2 onwards: the Zásilkovna mails are mostly unlabelled**, so the app learns about them only from the shop's mail, and only when the shop sent one. Severity: **minor** on its own, a contributor to 3.
6. **Day 2 to 10: the Czech words in the app are Slovak in places.** The GLS and Sportovní lines say "Údaje o balíku boli zaregistrované" and "Balík bol doručený", which are Slovak forms ("boli", "bol"), not Czech ("byly", "byl"). The Móda mail "Objednávka č. MB-1290 bola odoslaná" is also Slovak. I can read them, but I notice. Severity: **minor**.
7. **Day 7 onwards: the reminders repeat every day.** "Still waiting for you · day 2", then day 3, day 4 and so on, at 08:00 and 15:30 for the textbook and the Móda parcel. The count "day N" doesn't say what it counts. Severity: **minor**.
8. **Day 0: the default postcode is 81101, a Bratislava code.** Settings showed it before I touched anything. I changed it on the first-run page, and Settings then showed 60200, so the change held. Severity: **minor**, because a Brno user has to notice and fix it.
9. **Day 4, 22:00: the parcel name shows the shop, not the item.** "Knihkupectví Příkladné" and "Vinted" aren't what I think of as the parcel. Severity: **minor**.

**The app did it right but I didn't understand**

10. **Day 2, 15:00: "Registered" over "Zásilka byla podána".** I understood it, but I had to think about what "registered" means for a parcel I'd only ordered. Severity: **minor**.
11. **Day 4, 22:00: "no tracking number found in this message (it contains something shaped like a tracking number)".** I read this twice and still wasn't sure whether the app had found the number or not. Severity: **minor**.
12. **Day 7, 10:00: the ready notification gives the address but not the Z-BOX code.** The code is only in the mail, so I had to open Gmail to collect. This is the app being honest about what it knows, but it's still a step. Severity: **minor**.
13. **Day 0: the Gmail setup steps.** "Make an App Password" and "[2-Step Verification] has to be on" are written for someone who already knows Google's settings. I couldn't tell whether a .cz Gmail address is accepted, since the form says "you@gmail.com". Severity: **minor**, but it's where I'd call for help.

## 5. Missing features that block my day-to-day use

- **Day 4, 22:00, at /attention, I needed to assign the PPL charger.** There's no PPL carrier, and Detect guessed GLS. I needed PPL as an option, or at least a correct guess. The charger was delivered and the app lost it.
- **Day 6 to 9, the Kosmetika mails, I needed the app to see Zásilkovna directly.** Its mails to me aren't labelled, so they never reached the app. I needed the filter to include `zasilkovna.cz`, or the app to read Zásilkovna mails without the label.
- **Day 7, 10:00 and day 10, 08:30, at the Z-BOX and the Trafika, I needed the code or PIN on the parcel page.** The code was only in the mail, so I had to switch to Gmail at the box.
- **Day 10, 08:30, at the Trafika, I needed to pick up a parcel for Klára.** The app had no way to mark it as "for someone else" or to note who it was for. I used the name field as a workaround ("Kosmetika pro Kláru").

## 6. Other ideas

- **Czech carriers and Czech wording.** PPL and Česká pošta are missing from the carrier list and from the Gmail filter. Czech notifications would also help, since most of my mail is in Czech. (Day 4 and day 2.)
- **Reminder frequency.** Reminders come at 08:00 and 15:30 every day, which felt like nagging. A "remind me once a day" choice would help. (Day 7 to 10.)
- **Rename a parcel from the notification.** "Vinted" and "Knihkupectví Příkladné" would be clearer as "jacket" and "textbook". (Day 6 and day 2.)
- **Gmail filter templates for Czech.** Czech words such as "zásilka", "připravena", "vyzvednutí", "doručena" and "odesláno". (Day 0.)

## 7. Verdict

- **What I use today to keep track of parcels:** Gmail search, and for a code I open the mail again at the box. I don't have a carrier app.
- **Is Parcels better than that, and how?** For Packeta pickups, yes: the notifications tell me where to go and when the deadline is, and the Trafika and Z-BOX addresses are right there. For PPL and for Zásilkovna mails that aren't labelled, it's worse than Gmail, because it silently misses things and gives me false confidence.
- **Would I still use it after this week?** **Maybe.** It caught the textbook and the sweater and the jacket, and the reminders got me to the counter in time. But it missed the cosmetics and the charger, and that's exactly what I'd rely on it for.
- **What would make me uninstall it?** Another parcel I only found out about from a flatmate, or a deadline I missed because the app said nothing.
- **Score: 5 / 10.**
- **What I'd tell a friend:** "It handles Packeta pickups well, but it misses PPL and any Zásilkovna mail that isn't labelled, so keep checking Gmail too."
