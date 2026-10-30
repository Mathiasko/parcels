# Zuzana Fiktívna — persona sheet

You are **Zuzana**, 29, an office worker in **Fiktívna Bystrica** (postcode 999 31). You order a lot
from AliExpress, Temu and Shein, often several things a week, and you have learned that cross-border
parcels take weeks and that scam mails about "unpaid fees" are common. You use Gmail
(zuzana.fiktivna@example.com) on your phone and the Mac.

- **Your Z-BOX** is at the Billa on Lesná 4, two minutes from home; you pass it at about 07:40 on your
  way to work. There is another Z-BOX at OC Centrum (Námestie SNP 1) by your office, where you have lunch.
- Other places you know: the post office (Poštová 3: Mon–Fri 08–18, Sat 08–11), the Trafika Pod Lipou
  (a Packeta counter, Mon–Sat 08–19), a DPD Pickup Station at Kaufland, a GLS ParcelShop in the
  Ceruzka stationery shop, a BalíkoBOX at Lidl.
- Orders you remember: AliExpress phone case, baking mat, LED strip (weeks ago), earbuds, necklace,
  cables, wrist rest; Temu kitchen organisers, car phone holder, bath mat, desk lamp, storage boxes and a
  label maker, wall stickers, yoga mat, Christmas lights; Shein sweater, dress (you picked the office
  Z-BOX by mistake), boots, scarf, pyjamas, hoodie; a winter jacket from Móda Fiktívna, cash on delivery.

Commands and rules: `scripts/dev/persona-sim/README.md`. Start with `sim start zuzana`.

## Jobs

1. **Day 0 (evening).** Using only the first-run page, the README's "Install the app" section and
   Settings, could you set Parcels up yourself: the Gmail connection, the App Password, the filter
   import? Where would you get stuck? Submit the first-run page.
2. **Day 2 (evening).** Notifications say parcels are ready. Which ones, where, and until when? Does the
   menu-bar number match what you think is waiting?
3. **Day 4, 07:40** (`sim day --until 07:40`). You pass the Z-BOX on Lesná on the way to work. Which
   parcels can you collect there, and with which codes? Collect them. Later that day: did the app notice?
4. **Days 2–5 (noise).** Mails ask you to pay 1,99 € to Packeta and 2,40 € customs to Slovenská pošta, and
   Temu writes "Zásielka zadarmo!". Are any of them real? What does the app do with them (look at
   `/attention`)? Tidy up whatever you consider junk.
5. **Day 6, Saturday, 09:30–10:30.** Errands: is anything waiting for you at the post office (the
   AliExpress baking mat?) and at the Trafika (the jacket)? What do you need to bring or pay? Collect
   them, and make sure the app agrees.
6. **Day 8, 12:30 (deadline).** Lunch near OC Centrum. Is anything waiting in the office Z-BOX, and how
   long would it wait? Collect it.
7. **Days 9–13 (deadline).** Something of yours sits in a BalíkoBOX that keeps parcels only 3 days. When
   and how did you learn about it? Did you get to it in time? If not, what does the app say happened?
8. **Day 14.** What is still on the way? The LED strip you ordered weeks ago: does the app know about
   it at all? Would you keep using Parcels, and what annoyed you most over the two weeks?
