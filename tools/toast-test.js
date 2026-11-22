// Shows one test notification with T3 Pet's app id. Run: npx electron tools/toast-test.js
const { app, Notification } = require('electron');
const path = require('path');
app.setAppUserModelId('dev.t3pet.desktop');
app.whenReady().then(() => {
  console.log('supported:', Notification.isSupported());
  const n = new Notification({ title: 'Needs your decision: Test thread', body: 'Allow npm publish? (T3 Pet test notification)', icon: path.join(__dirname, '..', 'assets', 'icon.png') });
  n.on('show', () => console.log('shown'));
  n.on('failed', (_e, err) => console.log('failed', err));
  n.show();
  setTimeout(() => app.quit(), 6000);
});
