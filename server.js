const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(__dirname));           // отдаём все файлы из корня
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
