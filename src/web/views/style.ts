/** Inlined into every page: no static files, no build step. */
export const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --card: #fff; --line: #deded8; --accent: #1a5fb4; --warn: #b35900; --bad: #b3261e; --good: #1e7a3c }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #9a9a94; --card: #20201f; --line: #333331; --accent: #78aeed; --warn: #e8a24a; --bad: #f2827a; --good: #62c07f } }
* { box-sizing: border-box }
body { margin: 0; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: var(--bg); color: var(--fg) }
header { display: flex; gap: 1.2rem; align-items: baseline; padding: .8rem 1.2rem; border-bottom: 1px solid var(--line); background: var(--card) }
header strong { font-size: 1.05rem }
nav a { margin-right: 1rem; color: var(--muted); text-decoration: none }
nav a.current { color: var(--fg); font-weight: 600 }
main { max-width: 56rem; margin: 0 auto; padding: 1.2rem }
h1 { font-size: 1.3rem; margin: 0 0 1rem } h2 { font-size: 1.05rem; margin: 1.6rem 0 .6rem }
a { color: var(--accent) }
.muted { color: var(--muted) } .small { font-size: .85rem }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .8rem 1rem; margin-bottom: .7rem }
.card h3 { margin: 0 0 .2rem; font-size: 1rem }
.card h3 a { color: inherit; text-decoration: none }
.row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap }
.chip { display: inline-block; padding: .05rem .5rem; border-radius: 99px; font-size: .78rem; font-weight: 600; background: var(--line); color: var(--fg) }
.chip-delivered { background: var(--good); color: #fff } .chip-ready-for-pickup, .chip-out-for-delivery { background: var(--accent); color: #fff }
.chip-failed-attempt, .chip-problem, .chip-returning, .chip-returned { background: var(--bad); color: #fff }
.notice { border-left: 3px solid var(--warn); padding: .4rem .8rem; margin: .8rem 0; background: var(--card) }
.notice.alarm { border-color: var(--bad) } .notice.ok { border-color: var(--good) }
.alarm-text { color: var(--bad); font-weight: 600 }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px }
th, td { text-align: left; padding: .45rem .7rem; border-bottom: 1px solid var(--line); vertical-align: top }
th { font-size: .8rem; color: var(--muted); font-weight: 600 }
ol.timeline { list-style: none; padding: 0; margin: 0 } ol.timeline li { display: flex; gap: .8rem; padding: .4rem 0; border-bottom: 1px solid var(--line) }
ol.timeline time { min-width: 8.5rem; color: var(--muted); font-size: .85rem }
form.inline { display: inline } form.stack label { display: block; margin: .5rem 0 .15rem; font-size: .85rem; color: var(--muted) }
input, select, button { font: inherit; padding: .3rem .5rem; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg) }
button { cursor: pointer; background: var(--accent); color: #fff; border-color: var(--accent) }
pre { white-space: pre-wrap; word-break: break-all; max-height: 20rem; overflow: auto; background: var(--bg); padding: .5rem; border-radius: 6px; font-size: .78rem }
details { margin: .4rem 0 }
`
