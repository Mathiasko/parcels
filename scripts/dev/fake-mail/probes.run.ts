// Targeted probes behind FINDINGS.md: run single corpus mails (or small variants) through extract().
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'vitest'
import { extract, extractPickupCode, mailText, pickupFromMail } from '../../../src/ingest/extract.js'

const FIX = resolve(__dirname, '../../../test/fixtures/fake-mail')
const eml = (f: string) => readFileSync(join(FIX, f))
const swapSubject = (buf: Buffer, subject: string) => Buffer.from(buf.toString('latin1').replace(/^Subject: .*(\r\n .*)*$/m, `Subject: ${subject}`), 'latin1')

test('probes', async () => {
  const out: Record<string, unknown> = {}
  const t20 = await mailText(eml('20-gls-ready-glsbox-pin.eml'))
  out.gls20_text_excerpt = t20.slice(t20.indexOf('slo bal') - 10, t20.indexOf('slo bal') + 260)
  out.gls20_pickup = pickupFromMail(t20) ?? null
  out.gls20_extract = await extract(eml('20-gls-ready-glsbox-pin.eml'))
  out.gls20_subject_without_number = await extract(swapSubject(eml('20-gls-ready-glsbox-pin.eml'), 'Balik je pripraveny k vyzdvihnutiu'))
  out.real_gls_fixture_subject_without_number = await extract(swapSubject(readFileSync(resolve(__dirname, '../../../test/fixtures/mail/gls-ready-for-pickup.eml')), 'Balik je pripraveny k vyzdvihnutiu'))
  out.real_gls_fixture = await extract(readFileSync(resolve(__dirname, '../../../test/fixtures/mail/gls-ready-for-pickup.eml')))
  out.gls69_extract = await extract(eml('69-gls-last-chance-reminder.eml'))
  out.gls69_pickup = pickupFromMail(await mailText(eml('69-gls-last-chance-reminder.eml'))) ?? null
  out.newsletter07 = await extract(eml('07-newsletter-number-like.eml'))
  const nl = readFileSync(join(FIX, '07-newsletter-number-like.eml'), 'latin1')
  out.newsletter07_without_catalog_line = await extract(Buffer.from(nl.replace(/Katal=C3=B3gov=C3=A9 =C4=8D=C3=ADslo produktu 123456789012, /g, '').replace(/Katal.{0,40}produktu 123456789012, /g, ''), 'latin1'))
  out.outlook61 = await extract(eml('61-outlook-forwarded-gls-reminder.eml'))
  out.html41_text = (await mailText(eml('41-eshop-number-only-in-html.eml'))).slice(0, 200)
  out.long59 = await extract(eml('59-eshop-very-long-mail.eml'))
  out.misdeclared73 = await extract(eml('73-sps-delivered-misdeclared-charset.eml'))
  out.cz31_pickup = pickupFromMail(await mailText(eml('31-zasilkovna-cz-ready-iso8859-2.eml'))) ?? null
  out.cz31_extract = await extract(eml('31-zasilkovna-cz-ready-iso8859-2.eml'))
  out.en67 = await extract(eml('67-packeta-com-english.eml'))
  out.dpd43_pickup = pickupFromMail(await mailText(eml('43-dpd-pickup-station-ready-pin.eml'))) ?? null
  out.posta37_pickup = pickupFromMail(await mailText(eml('37-posta-stored-at-office-cod.eml'))) ?? null
  out.posta44_code = extractPickupCode(await mailText(eml('44-posta-balikobox-pin.eml'))) ?? null
  out.dpd43_code = extractPickupCode(await mailText(eml('43-dpd-pickup-station-ready-pin.eml'))) ?? null
  out.dhl35 = await extract(eml('35-dhl-express-dispatch.eml'))
  out.dhl38 = await extract(eml('38-dhl-customs-duties.eml'))
  out.posta37 = await extract(eml('37-posta-stored-at-office-cod.eml'))
  out.sps46 = await extract(eml('46-sps-courier-cod-phone.eml'))
  out.phish76 = await extract(eml('76-phishing-lookalike-packeta.eml'))
  out.promo08 = await extract(eml('08-packeta-promo-sample-number.eml'))
  out.dpd45 = await extract(eml('45-dpd-two-parcels-one-mail.eml'))
  out.split25 = await extract(eml('25-eshop-two-packeta-parcels.eml'))
  out.fwd29 = await extract(eml('29-gmail-forwarded-dpd.eml'))
  out.fwd62 = await extract(eml('62-gmail-cz-forwarded-zasilkovna-pickedup.eml'))
  out.express56 = await extract(eml('56-unknown-carrier-express-one.eml'))
  writeFileSync(join(FIX, 'out', 'probes.json'), JSON.stringify(out, null, 2))
})
