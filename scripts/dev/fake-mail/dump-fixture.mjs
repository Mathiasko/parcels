// Prints the decoded headers + text of an .eml (dev aid for building the fake-mail corpus).
import { readFileSync } from 'node:fs'
import { simpleParser } from 'mailparser'
for (const f of process.argv.slice(2)) {
  const m = await simpleParser(readFileSync(f))
  const t = (m.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').slice(0, Number(process.env.MAX ?? 3000))
  console.log(`===== ${f}\nFrom: ${m.from?.text}\nSubject: ${m.subject}\nDate: ${m.date?.toISOString()}\nCT: ${m.headers.get('content-type')?.value}\nhtml: ${typeof m.html === 'string' ? m.html.length : 0} attachments: ${m.attachments.map(a => a.contentType + ' ' + a.filename).join(', ')}\n--- text\n${t}`)
}
