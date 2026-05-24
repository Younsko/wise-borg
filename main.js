const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Launch the backend sniper server immediately inside the Electron main process
require('./server.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: "Wise Borg // Warframe.market Deal Sniper",
    backgroundColor: '#0a0d14', // Solid dark theme background to prevent white screen flash
    icon: path.join(__dirname, 'public', 'assets', 'icon.png'), // Beautiful app icon
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  // Remove standard browser menu bar for a clean standalone game-launcher style app
  mainWindow.removeMenu();

  // Intercept all link clicks and open them in the user's default system browser (Chrome/Edge/etc)
  // instead of loading them inside our dedicated sniper window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Wait for the Express server to fully bind to a port, then load it
  const checkPortInterval = setInterval(() => {
    if (global.activeExpressPort) {
      clearInterval(checkPortInterval);
      mainWindow.loadURL(`http://localhost:${global.activeExpressPort}`);
      console.log(`[Electron] Successfully loaded deal sniper on port ${global.activeExpressPort}`);
    }
  }, 50);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Ensure single instance of the application
const additionalData = { myKey: 'wise-borg-sniper' };
const isPrimaryInstance = app.requestSingleInstanceLock(additionalData);

if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', createWindow);

  app.on('window-all-closed', () => {
    // Shutdown the entire process cleanly
    app.quit();
  });
}
