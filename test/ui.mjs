import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (err) {
  console.error('These tests drive a real browser and need Playwright:\n\n  npm i -D playwright\n  npx playwright install chromium\n');
  process.exit(1);
}

const OUT = fileURLToPath(new global.URL('./screenshots/', import.meta.url));
const APP_URL = process.env.BASE_URL || 'http://127.0.0.1:8788/';
mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
};

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

async function openApp(name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  return { page, errors, name };
}

async function onboardName(page, name) {
  await page.fill('#nm', name);
  await page.click('[data-act="nm-next"]');
}

// ---- Partner A creates a pair -------------------------------------------
const A = await openApp('A');
check('A: onboarding renders', await A.page.isVisible('#nm'));
await onboardName(A.page, 'Miguel');
await A.page.click('[data-act="mode-new"]');
await A.page.click('[data-act="create"]');
await A.page.waitForSelector('.tabs button', { timeout: 10000 });
check('A: lands on the dashboard', (await A.page.textContent('#app')).includes('Miguel'));
check('A: week is sealed', (await A.page.textContent('#app')).includes('Sealed until you both answer'));

await A.page.click('[data-tab="settings"]');
await A.page.waitForSelector('[data-act="copy"]');
const code = (await A.page.textContent('#app')).match(/[A-Z2-9]{6}/)[0];
check('A: pairing code is shown', /^[A-Z2-9]{6}$/.test(code), code);

// ---- Partner B joins -----------------------------------------------------
const B = await openApp('B');
await onboardName(B.page, 'Sam');
await B.page.click('[data-act="mode-join"]');
await B.page.fill('#cd', code);
await B.page.click('[data-act="join"]');
await B.page.waitForSelector('.tabs button', { timeout: 10000 });
check('B: joined and sees the dashboard', (await B.page.textContent('#app')).includes('Sam'));

// A should now see B's name after a refresh
await A.page.reload({ waitUntil: 'networkidle' });
await A.page.click('[data-tab="settings"]');
check('A: sees partner name after joining', (await A.page.textContent('#app')).includes('Sam'));

// ---- A completes the check-in -------------------------------------------
await A.page.click('[data-tab="week"]');
await A.page.click('[data-act="begin"]');
for (let i = 0; i < 8; i++) {
  await A.page.waitForSelector('#sl');
  await A.page.fill('#sl', String(3 + i % 6));
  await A.page.click('[data-act="next"]');
}
await A.page.waitForSelector('#nt');
await A.page.fill('#nt', 'Secret note from Miguel');
await A.page.click('[data-act="submit"]');
await A.page.waitForSelector('[data-act="begin"]', { timeout: 10000 });
check('A: answers are in', (await A.page.textContent('#app')).includes('Your answers are in'));

// ---- The seal, as B sees it ---------------------------------------------
await B.page.reload({ waitUntil: 'networkidle' });
const bHome = await B.page.textContent('#app');
check('B: told that A has finished', bHome.includes('Waiting on you'));
check('B: cannot read A note in the DOM', !(await B.page.content()).includes('Secret note from Miguel'));
const bState = await B.page.evaluate(async () => {
  const r = await fetch('/api/state?tz=' + new Date().getTimezoneOffset(),
    { headers: { authorization: 'Bearer ' + localStorage.getItem('togetherly.token') } });
  return JSON.stringify(await r.json());
});
check("B: A's answers absent from the API payload too", !bState.includes('Secret note from Miguel'));

await B.page.screenshot({ path: OUT + 'shot-b-waiting.png', fullPage: true });

// ---- B completes, week opens --------------------------------------------
await B.page.click('[data-tab="week"]');
await B.page.click('[data-act="begin"]');
for (let i = 0; i < 8; i++) {
  await B.page.waitForSelector('#sl');
  await B.page.fill('#sl', String(4 + (i * 2) % 5));
  await B.page.click('[data-act="next"]');
}
await B.page.waitForSelector('#nt');
await B.page.fill('#nt', 'Sam had a hard week');
await B.page.click('[data-act="submit"]');
await B.page.waitForSelector('.card', { timeout: 10000 });
const bResults = await B.page.textContent('#app');
check('B: week opens', bResults.includes('Your week, opened'));
check('B: now sees A note', bResults.includes('Secret note from Miguel'));
check('B: results show the radar and next steps', bResults.includes('How you each saw it') && bResults.includes('Next step'));
await B.page.screenshot({ path: OUT + 'shot-b-results.png', fullPage: true });

// ---- Boos ----------------------------------------------------------------
await A.page.click('[data-tab="boo"]');
await A.page.click('[data-act="boo-begin"]');
await A.page.waitForSelector('input[data-stat="energy"]');
await A.page.fill('input[data-stat="energy"]', '9');
await A.page.fill('input[data-stat="mood"]', '8');
await A.page.click('[data-act="need"][data-k="laugh"]');
await A.page.fill('#bnt', 'Boo note from Miguel');
await A.page.click('[data-act="boo-share"]');
await A.page.waitForSelector('[data-act="boo-begin"]', { timeout: 10000 });
check('A: boo saved and shared', (await A.page.textContent('#app')).includes('Sam will see this'));

await B.page.click('[data-tab="boo"]');
await B.page.waitForTimeout(300);
const bBoo = await B.page.textContent('#app');
check("B: sees A's shared boo", bBoo.includes('Boo note from Miguel'));
check("B: sees A's requested move", bBoo.includes('Send me something stupid'));
await B.page.screenshot({ path: OUT + 'shot-b-boo.png', fullPage: true });

// A saves a private boo; B must not see it
await A.page.click('[data-act="boo-begin"]');
await A.page.waitForSelector('#bnt');
await A.page.fill('#bnt', 'Private boo, not for Sam');
await A.page.click('[data-act="boo-private"]');
await A.page.waitForSelector('[data-act="boo-begin"]', { timeout: 10000 });
await B.page.reload({ waitUntil: 'networkidle' });
await B.page.click('[data-tab="boo"]');
await B.page.waitForTimeout(300);
check('B: private boo stays private', !(await B.page.content()).includes('Private boo, not for Sam'));

// ---- Word of the day and jar --------------------------------------------
await A.page.click('[data-tab="home"]');
await A.page.waitForSelector('#wd');
await A.page.fill('#wd', 'steady');
await A.page.click('[data-act="word-save"]');
await A.page.waitForTimeout(500);
check('A: word saved', (await A.page.textContent('#app')).includes('Yours is in'));

await A.page.click('[data-act="jar-open"]');
await A.page.waitForSelector('#jr');
await A.page.fill('#jr', 'You made me laugh on Tuesday');
await A.page.click('[data-act="jar-add"]');
await A.page.waitForTimeout(500);
check('A: moment added to jar', (await A.page.textContent('#app')).includes('You made me laugh on Tuesday'));
await A.page.screenshot({ path: OUT + 'shot-a-home.png', fullPage: true });

// ---- Trends --------------------------------------------------------------
await A.page.click('[data-tab="insights"]');
await A.page.waitForTimeout(500);
const trends = await A.page.textContent('#app');
check('A: trends render with the week on record', trends.includes('1 week on the record'));
check('A: season card renders', trends.includes('Season 1'));
await A.page.screenshot({ path: OUT + 'shot-a-trends.png', fullPage: true });

// ---- Flicker -------------------------------------------------------------
// Every render used to rebuild #app inside a fresh .rise wrapper, replaying a
// 0.5s fade-and-slide on every click. Now the DOM is only rebuilt when the
// markup differs, and the animation only restarts on a real screen change.

await A.page.click('[data-tab="home"]');
await A.page.waitForTimeout(600);

// Tag a node, then re-render the same screen and check it survived.
await A.page.evaluate(() => {
  document.querySelector('#app .card').setAttribute('data-survivor', '1');
});
await A.page.click('[data-tab="home"]');          // same tab: nothing should change
await A.page.waitForTimeout(800);                 // let the refresh land too
check('re-rendering the same screen does not rebuild the DOM',
  await A.page.evaluate(() => !!document.querySelector('#app .card[data-survivor]')));

// A background poll on an unchanged screen must also leave the DOM alone.
await A.page.waitForTimeout(1200);
check('a background refresh does not rebuild the DOM',
  await A.page.evaluate(() => !!document.querySelector('#app .card[data-survivor]')));

// Typing must survive a refresh — the old version stole focus mid-word.
await A.page.click('[data-act="jar-open"]');
await A.page.waitForSelector('#jr');
await A.page.type('#jr', 'half a thou');
await A.page.waitForTimeout(1200);
check('a refresh does not steal focus while typing',
  await A.page.evaluate(() => document.activeElement && document.activeElement.id === 'jr'));
check('a refresh does not discard what you typed',
  await A.page.evaluate(() => document.getElementById('jr').value) === 'half a thou');

// Moving to a genuinely different screen should still animate.
await A.page.click('[data-tab="settings"]');
check('changing screen replays the entrance animation',
  await A.page.evaluate(() => document.getElementById('app').classList.contains('rise')));

// ---- Persistence ---------------------------------------------------------
await A.page.reload({ waitUntil: 'networkidle' });
await A.page.waitForSelector('.tabs button');
check('A: still signed in after reload', (await A.page.textContent('#app')).includes('Miguel'));

// ---- Sign out ------------------------------------------------------------
await A.page.click('[data-tab="settings"]');
await A.page.click('[data-act="signout"]');
await A.page.waitForSelector('#nm', { timeout: 10000 });
check('A: signed out back to onboarding', await A.page.isVisible('#nm'));

for (const app of [A, B]) {
  check(`${app.name}: no page errors`, app.errors.length === 0, app.errors.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
