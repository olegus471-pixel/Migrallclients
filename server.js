const express = require('express');
const path    = require('path');
const fs      = require('fs');
const app     = express();

// ── Переменные окружения → window.__ENV ──────────────────────
// Render.com: добавьте в Environment Variables:
//   GAS_URL           — URL Google Apps Script
//   SHEET_USERS       — ID таблицы Users
//   SHEET_CLIENTS     — ID таблицы Clients
//   SHEET_STATUSES    — ID таблицы Statuses
//   SHEET_COURTS      — ID таблицы Courts
//   SHEET_SCHEDULE    — ID таблицы Schedule
//   SHEET_CITIZENSHIP — ID таблицы Citizenship
//   SHEET_RIGHTS      — ID таблицы Rights
//   SHEET_ORDERS      — ID таблицы Orders
//   SHEET_TASKS       — ID таблицы Tasks
//   SHEET_FILINGS     — ID таблицы Filings
//   SHEET_SPEC_TASKS  — ID таблицы SpecTasks
//   DRIVE_ROOT        — ID корневой папки Google Drive
//   CALENDAR_ID       — ID командного календаря

const ENV = {
  GAS_URL:           process.env.GAS_URL           || '',
  SHEET_USERS:       process.env.SHEET_USERS        || '',
  SHEET_CLIENTS:     process.env.SHEET_CLIENTS      || '',
  SHEET_STATUSES:    process.env.SHEET_STATUSES     || '',
  SHEET_COURTS:      process.env.SHEET_COURTS       || '',
  SHEET_SCHEDULE:    process.env.SHEET_SCHEDULE     || '',
  SHEET_CITIZENSHIP: process.env.SHEET_CITIZENSHIP  || '',
  SHEET_RIGHTS:      process.env.SHEET_RIGHTS       || '',
  SHEET_ORDERS:      process.env.SHEET_ORDERS       || '',
  SHEET_TASKS:       process.env.SHEET_TASKS        || '',
  SHEET_FILINGS:     process.env.SHEET_FILINGS      || '',
  SHEET_SPEC_TASKS:  process.env.SHEET_SPEC_TASKS   || '',
  DRIVE_ROOT:        process.env.DRIVE_ROOT         || '',
  CALENDAR_ID:       process.env.CALENDAR_ID        || '',
};

// Статика (без index.html)
app.use(express.static(__dirname, { index: false }));

// index.html — инжектируем window.__ENV сразу после <head>
app.get('*', (req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.status(500).send('Server error'); return; }
    const envScript = `<script>\nwindow.__ENV = ${JSON.stringify(ENV)};\n</script>`;
    const injected  = html.replace('<head>', '<head>\n' + envScript);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log('MigrAll CRM on port ' + port);
  console.log('ENV:', Object.entries(ENV).map(([k,v]) => k + '=' + (v?'✓':'✗')).join(' | '));
});
