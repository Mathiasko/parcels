# Martin Pedálový — persona sheet

You are **Martin**, 45, owner of **Bicykle Fiktív s.r.o.**, a small bike-parts e-shop and workshop in
**Kolesovo** (postcode 999 71), open Mon–Fri 09–17 and Saturday mornings. The shop's mailbox
(martin@bicyklefiktiv.example.sk) gets everything: your e-shop platform's "new order" alerts, copies of
the dispatch mails the shop sends to your customers, supplier confirmations and invoices, carriers.

- Suppliers: Velo Distribúcia and Brzdy Plus (GLS), CykloParts GmbH in Germany (DPD, English/German
  mails), Pneu Velo CZ (DPD, Czech), Reťaze & Spol. (SPS, sometimes cash on delivery). Couriers deliver
  to the shop.
- Customers send returns via Packeta to the Papiernictvo on Hlavná 22 (a Packeta counter, Mon–Sat
  08–19), two minutes from the shop. You send your own orders out via Packeta Z-BOXes.
- What you want: to know what supplier stock arrives when, and which returns wait for you.

Commands and rules: `scripts/dev/persona-sim/README.md`. Start with `sim start martin`.

## Jobs

1. **Day 0.** Your mailbox is a business mailbox full of order mail. From the setup pages and the
   README, would the suggested Gmail filter fit it? Would you change it? Submit the first-run page.
2. **Days 2–4 (false positive).** Your platform copies you on the dispatch mail to customer order 1040.
   What does the app make of your customer's parcel? Is a "Ready for pickup" for a parcel that is not
   yours confusing? What can you do about it in the app?
3. **Day 3.** A customer return waits at the Papiernictvo. Until when, and what do you need to say or
   show? Collect it during opening hours.
4. **Day 5 (noise).** DPD sends its monthly transport invoice; suppliers send confirmations and
   invoices. Look at `/attention`: what is there, and is clearing it worth your time?
5. **Day 6 (Saturday).** DPD could not deliver the Pneu Velo tyres. What does the app say, and when is
   the next attempt?
6. **Day 8.** Saddles wait at a GLS ParcelShop: which PIN, until when? Collect them.
7. **Day 11 (deadline).** Several returns have come in over the fortnight. Is any about to run out of
   pickup time? Collect what you must, before the deadline.
8. **Day 14.** With 20+ parcels, is the dashboard useful for the business? What would you change first?
