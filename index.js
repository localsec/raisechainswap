import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";
import { HttpProxyAgent } from "http-proxy-agent"; // Thêm thư viện hỗ trợ proxy

// Lấy danh sách private keys và proxies từ biến môi trường
const PRIVATE_KEYS = process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(",") : [];
const PROXIES = process.env.PROXIES ? process.env.PROXIES.split(",") : [];
const WETH_ADDRESS = process.env.WETH_ADDRESS;
const NETWORK_NAME = "RISE TESTNET";

if (PRIVATE_KEYS.length === 0 || PROXIES.length === 0 || PRIVATE_KEYS.length !== PROXIES.length) {
  console.error("Cần cung cấp danh sách PRIVATE_KEYS và PROXIES hợp lệ với số lượng bằng nhau.");
  process.exit(1);
}

const ERC20ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const WETH_ABI = [
  "function deposit() public payable",
  "function withdraw(uint256 wad) public",
  "function approve(address guy, uint256 wad) public returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

// Lưu trữ thông tin nhiều ví
let walletsInfo = PRIVATE_KEYS.map((key, index) => ({
  privateKey: key,
  proxy: PROXIES[index],
  address: "",
  balanceNative: "0.00",
  balanceWeth: "0.00",
  network: NETWORK_NAME,
  status: "Đang khởi tạo",
  provider: null,
  wallet: null,
  nextNonce: null
}));

let currentWalletIndex = 0; // Chỉ số ví hiện tại
let transactionLogs = [];
let swapRunning = false;
let swapCancelled = false;
let gasPumpSwapRunning = false;
let gasPumpSwapCancelled = false;
let cloberSwapRunning = false;
let cloberSwapCancelled = false;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;

function getShortAddress(address) {
  return address.slice(0, 6) + "..." + address.slice(-4);
}
function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function addLog(message, type) {
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage = message;
  if (type === "gaspump") {
    coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  } else if (type === "clober") {
    coloredMessage = `{bright-magenta-fg}${message}{/bright-magenta-fg}`;
  } else if (type === "system") {
    coloredMessage = `{bright-white-fg}${message}{/bright-white-fg}`;
  } else if (type === "error") {
    coloredMessage = `{bright-red-fg}${message}{/bright-red-fg}`;
  } else if (type === "success") {
    coloredMessage = `{bright-green-fg}${message}{/bright-green-fg}`;
  } else if (type === "warning") {
    coloredMessage = `{bright-yellow-fg}${message}{/bright-yellow-fg}`;
  }
  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function getRandomDelay() {
  return Math.random() * (60000 - 30000) + 30000;
}
function getRandomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.setScrollPerc(100);
  safeRender();
}
function clearTransactionLogs() {
  transactionLogs = [];
  updateLogs();
  addLog("Nhật ký giao dịch đã được xóa.", "system");
}

async function waitWithCancel(delay, type) {
  return Promise.race([
    new Promise(resolve => setTimeout(resolve, delay)),
    new Promise(resolve => {
      const interval = setInterval(() => {
        if (type === "swap" && gasPumpSwapCancelled) { clearInterval(interval); resolve(); }
        if (type === "clober" && cloberSwapCancelled) { clearInterval(interval); resolve(); }
      }, 100);
    })
  ]);
}

function addTransactionToQueue(transactionFunction, description = "Giao dịch") {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({
    id: transactionId,
    description,
    timestamp: new Date().toLocaleTimeString(),
    status: "đang chờ"
  });
  addLog(`Giao dịch [${transactionId}] đã được thêm vào hàng đợi: ${description}`, "system");
  updateQueueDisplay();

  transactionQueue = transactionQueue.then(async () => {
    updateTransactionStatus(transactionId, "đang xử lý");
    addLog(`Giao dịch [${transactionId}] bắt đầu được xử lý.`, "system");
    try {
      const walletInfo = walletsInfo[currentWalletIndex];
      if (walletInfo.nextNonce === null) {
        walletInfo.nextNonce = await walletInfo.provider.getTransactionCount(walletInfo.address, "pending");
        addLog(`Nonce ban đầu ví ${getShortAddress(walletInfo.address)}: ${walletInfo.nextNonce}`, "system");
      }
      const result = await transactionFunction(walletInfo.nextNonce);
      walletInfo.nextNonce++;
      updateTransactionStatus(transactionId, "hoàn thành");
      addLog(`Giao dịch [${transactionId}] đã hoàn thành.`, "system");
      return result;
    } catch (error) {
      updateTransactionStatus(transactionId, "lỗi");
      addLog(`Giao dịch [${transactionId}] thất bại: ${error.message}`, "system");
      if (error.message && error.message.toLowerCase().includes("nonce has already been used")) {
        walletsInfo[currentWalletIndex].nextNonce++;
        addLog(`Nonce ví ${getShortAddress(walletsInfo[currentWalletIndex].address)} tăng lên: ${walletsInfo[currentWalletIndex].nextNonce}`, "system");
      }
      return;
    } finally {
      removeTransactionFromQueue(transactionId);
      updateQueueDisplay();
    }
  });
  return transactionQueue;
}
function updateTransactionStatus(id, status) {
  transactionQueueList.forEach(tx => {
    if (tx.id === id) tx.status = status;
  });
  updateQueueDisplay();
}
function removeTransactionFromQueue(id) {
  transactionQueueList = transactionQueueList.filter(tx => tx.id !== id);
  updateQueueDisplay();
}
function getTransactionQueueContent() {
  if (transactionQueueList.length === 0) return "Không có giao dịch nào trong hàng đợi.";
  return transactionQueueList
    .map(tx => `ID: ${tx.id} | ${tx.description} | ${tx.status} | ${tx.timestamp}`)
    .join("\n");
}
let queueMenuBox = null;
let queueUpdateInterval = null;
function showTransactionQueueMenu() {
  const container = blessed.box({
    label: " Hàng đợi giao dịch ",
    top: "10%",
    left: "center",
    width: "80%",
    height: "80%",
    border: { type: "line" },
    style: { border: { fg: "blue" } },
    keys: true,
    mouse: true,
    interactive: true
  });
  const contentBox = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: "90%",
    content: getTransactionQueueContent(),
    scrollable: true,
    keys: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } }
  });
  const exitButton = blessed.button({
    content: " [Thoát] ",
    bottom: 0,
    left: "center",
    shrink: true,
    padding: { left: 1, right: 1 },
    style: { fg: "white", bg: "red", hover: { bg: "blue" } },
    mouse: true,
    keys: true,
    interactive: true
  });
  exitButton.on("press", () => {
    addLog("Thoát khỏi Menu Hàng đợi Giao dịch.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.key(["a", "s", "d"], () => {
    addLog("Thoát khỏi Menu Hàng đợi Giao dịch.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.append(contentBox);
  container.append(exitButton);
  queueUpdateInterval = setInterval(() => {
    contentBox.setContent(getTransactionQueueContent());
    screen.render();
  }, 1000);
  mainMenu.hide();
  screen.append(container);
  container.focus();
  screen.render();
}
function updateQueueDisplay() {
  if (queueMenuBox) {
    queueMenuBox.setContent(getTransactionQueueContent());
    screen.render();
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "GasPump Swap",
  fullUnicode: true,
  mouse: true
});
let renderTimeout;
function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => { screen.render(); }, 50);
}
const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white", bg: "default" }
});
figlet.text("LocalSec".toUpperCase(), { font: "Speed", horizontalLayout: "default" }, (err, data) => {
  if (err) headerBox.setContent("{center}{bold}LocalSec{/bold}{/center}");
  else headerBox.setContent(`{center}{bold}{bright-cyan-fg}${data}{/bright-cyan-fg}{/bold}{/center}`);
  safeRender();
});
const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content: "{center}{bold}{bright-yellow-fg}✦ ✦ RISE AUTO BOT V1 ✦ ✦{/bright-yellow-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white", bg: "default" }
});
const logsBox = blessed.box({
  label: " Nhật ký giao dịch ",
  left: 0,
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  content: "",
  style: { border: { fg: "bright-cyan" }, bg: "default" }
});
const walletBox = blessed.box({
  label: " Thông tin ví ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, fg: "white", bg: "default", align: "left", valign: "top" },
  content: "Đang tải dữ liệu ví..."
});
const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "green", fg: "black" } },
  items: getMainMenuItems()
});

function getSwapMenuItems() {
  let items = [];
  if (gasPumpSwapRunning) {
    items.push("Dừng giao dịch");
  }
  items = items.concat(["Tự động Swap ETH & WETH", "{grey-fg}Thêm cặp khác sắp ra mắt{/grey-fg}", "Xóa nhật ký giao dịch", "Quay lại Menu chính", "Làm mới"]);
  return items;
}

function getCloberSwapMenuItems() {
  let items = [];
  if (cloberSwapRunning) {
    items.push("Dừng giao dịch");
  }
  items = items.concat(["Tự động Swap ETH & WETH", "{grey-fg}Thêm cặp khác sắp ra mắt{/grey-fg}", "Xóa nhật ký giao dịch", "Quay lại Menu chính", "Làm mới"]);
  return items;
}

const swapSubMenu = blessed.list({
  label: " Menu con GasPump Swap ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: getSwapMenuItems()
});
swapSubMenu.hide();

const cloberSwapSubMenu = blessed.list({
  label: " Menu con Clober Swap ",
  left: "60%",
  keys: true,
  vi: true,
  tags: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: getCloberSwapMenuItems()
});
cloberSwapSubMenu.hide();

const promptBox = blessed.prompt({
  parent: screen,
  border: "line",
  height: 5,
  width: "60%",
  top: "center",
  left: "center",
  label: "{bright-blue-fg}Nhập Swap{/bright-blue-fg}",
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  style: { fg: "bright-red", bg: "default", border: { fg: "red" } }
});
screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(swapSubMenu);
screen.append(cloberSwapSubMenu);

function adjustLayout() {
  const screenHeight = screen.height;
  const screenWidth = screen.width;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.top = 0;
  headerBox.height = headerHeight;
  headerBox.width = "100%";
  descriptionBox.top = "25%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = screenHeight - (headerHeight + descriptionBox.height);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = headerHeight + descriptionBox.height + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  swapSubMenu.top = mainMenu.top;
  swapSubMenu.left = mainMenu.left;
  swapSubMenu.width = mainMenu.width;
  swapSubMenu.height = mainMenu.height;
  cloberSwapSubMenu.top = mainMenu.top;
  cloberSwapSubMenu.left = mainMenu.left;
  cloberSwapSubMenu.width = mainMenu.width;
  cloberSwapSubMenu.height = mainMenu.height;
  safeRender();
}
screen.on("resize", adjustLayout);
adjustLayout();

async function initializeWallets() {
  for (let i = 0; i < walletsInfo.length; i++) {
    try {
      const walletInfo = walletsInfo[i];
      const agent = new HttpProxyAgent(walletInfo.proxy);
      const provider = new ethers.JsonRpcProvider(process.env.RPC_RISE, undefined, {
        fetchOptions: { agent }
      });
      const wallet = new ethers.Wallet(walletInfo.privateKey, provider);
      walletInfo.provider = provider;
      walletInfo.wallet = wallet;
      walletInfo.address = wallet.address;
      addLog(`Khởi tạo ví ${getShortAddress(walletInfo.address)} với proxy ${walletInfo.proxy}`, "system");
    } catch (error) {
      addLog(`Không thể khởi tạo ví ${i + 1}: ${error.message}`, "error");
    }
  }
}

async function updateWalletData() {
  try {
    const walletInfo = walletsInfo[currentWalletIndex];
    const nativeBalance = await walletInfo.provider.getBalance(walletInfo.address);
    walletInfo.balanceNative = ethers.formatEther(nativeBalance);
    const tokenContract = new ethers.Contract(WETH_ADDRESS, ERC20ABI, walletInfo.provider);
    const wethBalance = await tokenContract.balanceOf(walletInfo.address);
    walletInfo.balanceWeth = ethers.formatEther(wethBalance);
    updateWallet();
    addLog(`Số dư ví ${getShortAddress(walletInfo.address)} đã được cập nhật !!`, "system");
  } catch (error) {
    addLog(`Không thể lấy dữ liệu ví ${getShortAddress(walletsInfo[currentWalletIndex].address)}: ${error.message}`, "system");
  }
}
function updateWallet() {
  const walletInfo = walletsInfo[currentWalletIndex];
  const shortAddress = walletInfo.address ? getShortAddress(walletInfo.address) : "N/A";
  const native = walletInfo.balanceNative ? Number(walletInfo.balanceNative).toFixed(4) : "0.0000";
  const weth = walletInfo.balanceWeth ? Number(walletInfo.balanceWeth).toFixed(4) : "0.0000";
  const content = `┌── Địa chỉ   : {bright-yellow-fg}${shortAddress}{/bright-yellow-fg}
│   ├── ETH        : {bright-green-fg}${native}{/bright-green-fg}
│   └── WETH       : {bright-green-fg}${weth}{/bright-green-fg}
└── Mạng        : {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`;
  walletBox.setContent(content);
  safeRender();
}

function stopAllTransactions() {
  if (gasPumpSwapRunning || cloberSwapRunning) {
    gasPumpSwapCancelled = true;
    cloberSwapCancelled = true;
    addLog("Dừng tất cả giao dịch: Tất cả giao dịch sẽ bị dừng.", "system");
  }
}

async function runAutoSwapETHWETH() {
  promptBox.setFront();
  promptBox.readInput("Nhập số lượng swap ETH & WETH", "", async (err, value) => {
    promptBox.hide();
    safeRender();
    if (err || !value) {
      addLog("GasPump Swap: Dữ liệu nhập không hợp lệ hoặc đã bị hủy.", "gaspump");
      return;
    }
    const loopCount = parseInt(value);
    if (isNaN(loopCount)) {
      addLog("GasPump Swap: Dữ liệu nhập phải là số.", "gaspump");
      return;
    }
    addLog(`GasPump Swap: Bắt đầu ${loopCount} vòng lặp.`, "gaspump");

    gasPumpSwapRunning = true;
    gasPumpSwapCancelled = false;
    mainMenu.setItems(getMainMenuItems());
    swapSubMenu.setItems(getSwapMenuItems());
    swapSubMenu.show();
    safeRender();

    // Chạy lần lượt từng ví
    for (let walletIndex = 0; walletIndex < walletsInfo.length; walletIndex++) {
      currentWalletIndex = walletIndex;
      const walletInfo = walletsInfo[currentWalletIndex];
      addLog(`Bắt đầu xử lý ví ${getShortAddress(walletInfo.address)}`, "system");
      await updateWalletData();

      const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, walletInfo.wallet);
      let currentState = "ETH";

      for (let i = 1; i <= loopCount; i++) {
        if (gasPumpSwapCancelled) {
          addLog(`GasPump: Tự động Swap ETH & WETH bị dừng tại ví ${getShortAddress(walletInfo.address)} vòng ${i}.`, "gaspump");
          break;
        }
        const randomAmount = getRandomNumber(0.0001, 0.001);
        const amount = ethers.parseEther(randomAmount.toFixed(6));

        await addTransactionToQueue(async (nonce) => {
          let tx;
          if (currentState === "ETH") {
            try {
              addLog(`GasPump: Thực hiện Swap ${randomAmount.toFixed(6)} ETH ➯ WETH cho ví ${getShortAddress(walletInfo.address)}.`, "gaspump");
              tx = await wethContract.deposit({ value: amount, gasLimit: 100000, nonce: nonce });
              addLog(`GasPump: Đang gửi giao dịch ... Hash: ${getShortHash(tx.hash)}`, "gaspump");
              await tx.wait();
              addLog(`GasPump: Giao dịch thành công!! Hash: ${getShortHash(tx.hash)}`, "success");
              currentState = "WETH";
            } catch (error) {
              addLog(`GasPump: Lỗi ví ${getShortAddress(walletInfo.address)}: ${error.message}`, "error");
            }
          } else {
            try {
              addLog(`GasPump: Thực hiện Swap ${randomAmount.toFixed(6)} WETH ➯ ETH cho ví ${getShortAddress(walletInfo.address)}.`, "gaspump");
              const currentAllowance = await wethContract.allowance(walletInfo.address, WETH_ADDRESS);
              if (currentAllowance < amount) {
                addLog(`GasPump: Giao dịch cần phê duyệt cho ví ${getShortAddress(walletInfo.address)}.`, "gaspump");
                const approveTx = await wethContract.approve(WETH_ADDRESS, ethers.MaxUint256, { gasLimit: 100000, nonce: nonce });
                addLog(`GasPump: Đã gửi phê duyệt.. Hash: ${getShortHash(approveTx.hash)}`, "gaspump");
                await approveTx.wait();
                addLog(`GasPump: Phê duyệt thành công cho ví ${getShortAddress(walletInfo.address)}.`, "success");
              }
              tx = await wethContract.withdraw(amount, { gasLimit: 100000, nonce: nonce });
              addLog(`GasPump: Đang gửi giao dịch... Hash: ${getShortHash(tx.hash)}`, "gaspump");
              await tx.wait();
              addLog(`GasPump: Giao dịch thành công!! Hash: ${getShortHash(tx.hash)}`, "success");
              await updateWalletData();
              currentState = "ETH";
            } catch (error) {
              addLog(`Lỗi Swap ví ${getShortAddress(walletInfo.address)}: ${error.message}`, "error");
            }
          }
        }, `GasPump Swap - Ví ${getShortAddress(walletInfo.address)} - Vòng thứ ${i}`);

        if (i < loopCount) {
          const delayTime = getRandomDelay();
          const minutes = Math.floor(delayTime / 60000);
          const seconds = Math.floor((delayTime % 60000) / 1000);
          addLog(`Swap thứ ${i} hoàn thành cho ví ${getShortAddress(walletInfo.address)}. Đang chờ ${minutes} phút ${seconds} giây.`, "gaspump");
          await waitWithCancel(delayTime, "swap");
          if (gasPumpSwapCancelled) {
            addLog(`GasPump Swap: Bị dừng trong thời gian chờ cho ví ${getShortAddress(walletInfo.address)}.`, "gaspump");
            break;
          }
        }
      }
      if (gasPumpSwapCancelled) break;
    }

    gasPumpSwapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    swapSubMenu.setItems(getSwapMenuItems());
    safeRender();
    addLog("GasPump Swap: Tự động Swap ETH & WETH hoàn tất cho tất cả ví.", "gaspump");
  });
}

async function runCloberSwapETHWETH() {
  promptBox.setFront();
  promptBox.readInput("Nhập số lượng swap ETH & WETH:", "", async (err, value) => {
    promptBox.hide();
    safeRender();
    if (err || !value) {
      addLog("Clober Swap: Dữ liệu nhập không hợp lệ hoặc đã bị hủy.", "clober");
      return;
    }
    const loopCount = parseInt(value);
    if (isNaN(loopCount)) {
      addLog("Clober Swap: Dữ liệu nhập phải là số.", "clober");
      return;
    }
    addLog(`Clober Swap: Bắt đầu ${loopCount} vòng lặp.`, "clober");

    cloberSwapRunning = true;
    cloberSwapCancelled = false;
    mainMenu.setItems(getMainMenuItems());
    cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
    cloberSwapSubMenu.show();
    safeRender();

    // Chạy lần lượt từng ví
    for (let walletIndex = 0; walletIndex < walletsInfo.length; walletIndex++) {
      currentWalletIndex = walletIndex;
      const walletInfo = walletsInfo[currentWalletIndex];
      addLog(`Bắt đầu xử lý ví ${getShortAddress(walletInfo.address)}`, "system");
      await updateWalletData();

      const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, walletInfo.wallet);
      let currentState = "ETH";

      for (let i = 1; i <= loopCount; i++) {
        if (cloberSwapCancelled) {
          addLog(`Clober Swap: Bị dừng tại ví ${getShortAddress(walletInfo.address)} vòng thứ ${i}.`, "clober");
          break;
        }
        const randomAmount = getRandomNumber(0.0001, 0.001);
        const amount = ethers.parseEther(randomAmount.toFixed(6));

        await addTransactionToQueue(async (nonce) => {
          let tx;
          if (currentState === "ETH") {
            try {
              addLog(`Clober: Thực hiện Swap ${randomAmount.toFixed(6)} ETH ➯ WETH cho ví ${getShortAddress(walletInfo.address)}`, "clober");
              tx = await wethContract.deposit({ value: amount, gasLimit: 100000, nonce: nonce });
              addLog(`Clober: Đang gửi giao dịch... Hash:${getShortHash(tx.hash)}`, "clober");
              await tx.wait();
              addLog(`Clober: Giao dịch thành công cho ví ${getShortAddress(walletInfo.address)}`, "success");
              currentState = "WETH";
            } catch (error) {
              addLog(`Clober: Lỗi ví ${getShortAddress(walletInfo.address)}: ${error.message}`, "error");
            }
          } else {
            try {
              addLog(`Clober: Thực hiện Swap ${randomAmount.toFixed(6)} WETH ➯ ETH cho ví ${getShortAddress(walletInfo.address)}.`, "clober");
              const currentAllowance = await wethContract.allowance(walletInfo.address, WETH_ADDRESS);
              if (currentAllowance < amount) {
                addLog(`Clober: Giao dịch cần phê duyệt cho ví ${getShortAddress(walletInfo.address)}`, "clober");
                const approveTx = await wethContract.approve(WETH_ADDRESS, ethers.MaxUint256, { gasLimit: 100000, nonce: nonce });
                addLog(`Clober: Đã gửi phê duyệt... Hash: ${getShortHash(approveTx.hash)}`, "clober");
                await approveTx.wait();
                addLog(`Clober: Phê duyệt thành công cho ví ${getShortAddress(walletInfo.address)}`, "success");
              }
              tx = await wethContract.withdraw(amount, { gasLimit: 100000, nonce: nonce });
              addLog(`Clober: Đang gửi giao dịch... Hash: ${getShortHash(tx.hash)}`, "clober");
              await tx.wait();
              addLog(`Clober: Giao dịch thành công cho ví ${getShortAddress(walletInfo.address)}`, "success");
              await updateWalletData();
              currentState = "ETH";
            } catch (error) {
              addLog(`Lỗi rút tiền (Clober) ví ${getShortAddress(walletInfo.address)}: ${error.message}`, "error");
            }
          }
        }, `Clober Swap - Ví ${getShortAddress(walletInfo.address)} - Vòng thứ ${i}`);

        if (i < loopCount) {
          const delayTime = getRandomDelay();
          const minutes = Math.floor(delayTime / 60000);
          const seconds = Math.floor((delayTime % 60000) / 1000);
          addLog(`Clober Swap: Vòng thứ ${i} hoàn thành cho ví ${getShortAddress(walletInfo.address)}. Đang chờ ${minutes} phút ${seconds} giây`, "clober");
          await waitWithCancel(delayTime, "swap");
          if (cloberSwapCancelled) {
            addLog(`Clober Swap: Bị dừng trong thời gian chờ cho ví ${getShortAddress(walletInfo.address)}.`, "clober");
            break;
          }
        }
      }
      if (cloberSwapCancelled) break;
    }

    cloberSwapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
    safeRender();
    addLog("Clober Swap: Quá trình hoàn tất cho tất cả ví.", "clober");
  });
}

function getMainMenuItems() {
  let items = [];
  if (gasPumpSwapRunning || cloberSwapRunning) {
    items.push("Dừng tất cả giao dịch");
  }
  items = items.concat(["GasPump Swap", "Clober Swap", "Hàng đợi giao dịch", "Xóa nhật ký giao dịch", "Làm mới", "Thoát"]);
  return items;
}

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "GasPump Swap") {
    swapSubMenu.show();
    swapSubMenu.focus();
    safeRender();
  } else if (selected === "Clober Swap") {
    cloberSwapSubMenu.show();
    cloberSwapSubMenu.focus();
    safeRender();
  } else if (selected === "Hàng đợi giao dịch") {
    showTransactionQueueMenu();
  } else if (selected === "Dừng tất cả giao dịch") {
    stopAllTransactions();
    mainMenu.setItems(getMainMenuItems());
    mainMenu.focus();
    safeRender();
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Làm mới") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Đã làm mới", "system");
  } else if (selected === "Thoát") {
    process.exit(0);
  }
});
swapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Tự động Swap ETH & WETH") {
    if (gasPumpSwapRunning) {
      addLog("Giao dịch GasPump Swap đang chạy. Vui lòng dừng giao dịch trước.", "warning");
    } else {
      runAutoSwapETHWETH();
    }
  } else if (selected === "Dừng giao dịch") {
    if (gasPumpSwapRunning) {
      gasPumpSwapCancelled = true;
      addLog("GasPump Swap: Lệnh dừng giao dịch đã được nhận.", "swap");
    } else {
      addLog("GasPump Swap: Không có giao dịch nào đang chạy.", "swap");
    }
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Quay lại Menu chính") {
    swapSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Làm mới") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Đã làm mới", "system");
  }
});

cloberSwapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Tự động Swap ETH & WETH") {
    if (cloberSwapRunning) {
      addLog("Giao dịch Clober Swap đang chạy. Vui lòng dừng giao dịch trước.", "warning");
    } else {
      runCloberSwapETHWETH();
    }
  } else if (selected === "Dừng giao dịch") {
    if (cloberSwapRunning) {
      cloberSwapCancelled = true;
      addLog("Clober Swap: Lệnh dừng giao dịch đã được nhận.", "swap");
    } else {
      addLog("Clober Swap: Không có giao dịch nào đang chạy.", "swap");
    }
  } else if (selected === "Xóa nhật ký giao dịch") {
    clearTransactionLogs();
  } else if (selected === "Quay lại Menu chính") {
    cloberSwapSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Làm mới") {
    updateWalletData();
    updateLogs();
    safeRender();
    addLog("Đã làm mới", "system");
  }
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => { logsBox.scroll(-1); safeRender(); });
screen.key(["C-down"], () => { logsBox.scroll(1); safeRender(); });

safeRender();
mainMenu.focus();
addLog("Chúc bạn một buổi sáng tốt lành!! @LocalSec", "system");
updateLogs();
initializeWallets().then(() => {
  updateWalletData();
});
