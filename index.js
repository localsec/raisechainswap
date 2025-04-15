import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

const RPC_RISE = process.env.RPC_RISE;      
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WETH_ADDRESS = process.env.WETH_ADDRESS;
const NETWORK_NAME = "RISE TESTNET";

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

let walletInfo = {
  address: "",
  balanceNative: "0.00",
  balanceWeth: "0.00",
  network: NETWORK_NAME,
  status: "Đang khởi tạo"
};

let transactionLogs = [];
let swapRunning = false;
let swapCancelled = false;
let gasPumpSwapRunning = false;
let gasPumpSwapCancelled = false;
let cloberSwapRunning = false;
let cloberSwapCancelled = false;
let globalWallet = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonce = null;

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
  } else if (type === "clober"){
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
      if (nextNonce === null) {
        const provider = new ethers.JsonRpcProvider(RPC_RISE);
        nextNonce = await provider.getTransactionCount(globalWallet.address, "pending");
        addLog(`Nonce ban đầu: ${nextNonce}`, "system");
      }
      const result = await transactionFunction(nextNonce);
      nextNonce++;
      updateTransactionStatus(transactionId, "hoàn thành");
      addLog(`Giao dịch [${transactionId}] đã hoàn thành.`, "system");
      return result;
    } catch (error) {
      updateTransactionStatus(transactionId, "lỗi");
      addLog(`Giao dịch [${transactionId}] thất bại: ${error.message}`, "system");
      if (error.message && error.message.toLowerCase().includes("nonce has already been used")) {
        nextNonce++;
        addLog(`Nonce đã được tăng vì đã sử dụng. Giá trị nonce mới: ${nextNonce}`, "system");
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
  items = items.concat(["Tự động Swap ETH & WETH","{grey-fg}Thêm cặp khác sắp ra mắt{/grey-fg}", "Xóa nhật ký giao dịch", "Quay lại Menu chính", "Làm mới"]);
  return items;
}

function getCloberSwapMenuItems() {
  let items = [];
  if (cloberSwapRunning) {
    items.push("Dừng giao dịch");
  }
  items = items.concat(["Tự động Swap ETH & WETH","{grey-fg}Thêm cặp khác sắp ra mắt{/grey-fg}", "Xóa nhật ký giao dịch", "Quay lại Menu chính", "Làm mới"]);
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

async function updateWalletData() {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_RISE);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    globalWallet = wallet;
    walletInfo.address = wallet.address;
    const nativeBalance = await provider.getBalance(wallet.address);
    walletInfo.balanceNative = ethers.formatEther(nativeBalance);
    const tokenContract = (address) => new ethers.Contract(address, ERC20ABI, provider);
    const wethBalance = await tokenContract(WETH_ADDRESS).balanceOf(wallet.address);
    walletInfo.balanceWeth = ethers.formatEther(wethBalance);
    updateWallet();
    addLog("Số dư & Ví đã được cập nhật !!", "system");
  } catch (error) {
    addLog("Không thể lấy dữ liệu ví: " + error.message, "system");
  }
}
function updateWallet() {
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

    const provider = new ethers.JsonRpcProvider(RPC_RISE);
    const wallet = globalWallet || new ethers.Wallet(PRIVATE_KEY, provider);
    const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);

    let currentState = "ETH"; 

    for (let i = 1; i <= loopCount; i++) {
      if (gasPumpSwapCancelled) {
        addLog(`GasPump: Tự động Swap ETH & WETH bị dừng tại vòng ${i}.`, "gaspump");
        break;
      }
      const randomAmount = getRandomNumber(0.0001, 0.001);
      const amount = ethers.parseEther(randomAmount.toFixed(6));

      await addTransactionToQueue(async (nonce) => {
        let tx;
        if (currentState === "ETH") {
          try {
            addLog(`GasPump: Thực hiện Swap ${randomAmount.toFixed(6)} ETH ➯ WETH.`, "gaspump");
            tx = await wethContract.deposit({ value: amount, gasLimit: 100000, nonce: nonce });
            addLog(`GasPump: Đang gửi giao dịch ... Hash: ${getShortHash(tx.hash)}`, "gaspump");
            await tx.wait();
            addLog(`GasPump: Giao dịch thành công!! Hash: ${getShortHash(tx.hash)}`, "success");
            currentState = "WETH";
          } catch (error) {
            addLog(`GasPump: Lỗi ${error.message}`, "error");
          }
        } else {
          try {
            addLog(`GasPump: Thực hiện Swap ${randomAmount.toFixed(6)} WETH ➯ ETH.`, "gaspump");
            const currentAllowance = await wethContract.allowance(wallet.address, WETH_ADDRESS);
            if (currentAllowance < amount) {
              addLog("GasPump: Giao dịch cần phê duyệt.", "GasPump");
              const approveTx = await wethContract.approve(WETH_ADDRESS, ethers.MaxUint256, { gasLimit: 100000, nonce: nonce });
              addLog(`GasPump: Đã gửi phê duyệt.. Hash: ${getShortHash(approveTx.hash)}`, "gaspump");
              await approveTx.wait();
              addLog("GasPump: Phê duyệt thành công.", "success");
            }
            tx = await wethContract.withdraw(amount, { gasLimit: 100000, nonce: nonce });
            addLog(`GasPump: Đang gửi giao dịch... Hash: ${getShortHash(tx.hash)}`, "gaspump");
            await tx.wait();
            addLog(`GasPump: Giao dịch thành công!! Hash: ${getShortHash(tx.hash)}`, "success");
            await updateWalletData();
            currentState = "ETH";
          } catch (error) {
            addLog(`Lỗi Swap: ${error.message}`, "error");
          }
        }
      }, `GasPump Swap - Vòng thứ ${i}`);

      if (i < loopCount) {
        const delayTime = getRandomDelay();
        const minutes = Math.floor(delayTime / 60000);
        const seconds = Math.floor((delayTime % 60000) / 1000);
        addLog(`Swap thứ ${i} hoàn thành. Đang chờ ${minutes} phút ${seconds} giây.`, "gaspump");
        await waitWithCancel(delayTime, "swap");
        if (gasPumpSwapCancelled) {
          addLog("GasPump Swap: Bị dừng trong thời gian chờ.", "gaspump");
          break;
        }
      }
    }
    gasPumpSwapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    swapSubMenu.setItems(getSwapMenuItems());
    safeRender();
    addLog("GasPump Swap: Tự động Swap ETH & WETH hoàn tất.", "gaspump");
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

    const provider = new ethers.JsonRpcProvider(RPC_RISE);
    const wallet = globalWallet || new ethers.Wallet(PRIVATE_KEY, provider);
    const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);

    let currentState = "ETH";
    cloberSwapRunning = true;
    cloberSwapCancelled = false;
    mainMenu.setItems(getMainMenuItems());
    cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
    cloberSwapSubMenu.show();
    safeRender();

    for (let i = 1; i <= loopCount; i++) {
      if (cloberSwapCancelled) {
        addLog(`Clober Swap: Bị dừng tại vòng thứ ${i}.`, "clober");
        break;
      }
      const randomAmount = getRandomNumber(0.0001, 0.001);
      const amount = ethers.parseEther(randomAmount.toFixed(6));

      await addTransactionToQueue(async (nonce) => {
        let tx;
        if (currentState === "ETH") {
          try {
            addLog(`Clober: Thực hiện Swap ${randomAmount.toFixed(6)} ETH ➯ WETH`, "clober");
            tx = await wethContract.deposit({ value: amount, gasLimit: 100000, nonce: nonce });
            addLog(`Clober: Đang gửi giao dịch... Hash:${getShortHash(tx.hash)}`, "clober");
            await tx.wait();
            addLog("Clober: Giao dịch thành công", "success");
            currentState = "WETH";
          } catch (error) {
            addLog(`Clober: Lỗi ${error.message}`, "error");
          }
        } else {
          try {
            addLog(`Clober: Thực hiện Swap ${randomAmount.toFixed(6)} WETH ➯ ETH.`, "clober");
            const currentAllowance = await wethContract.allowance(wallet.address, WETH_ADDRESS);
            if (currentAllowance < amount) {
              addLog("Clober: Giao dịch cần phê duyệt", "clober");
              const approveTx = await wethContract.approve(WETH_ADDRESS, ethers.MaxUint256, { gasLimit: 100000, nonce: nonce });
              addLog(`Clober: Đã gửi phê duyệt... Hash: ${getShortHash(approveTx.hash)}`, "clober");
              await approveTx.wait();
              addLog("Clober: Phê duyệt thành công", "success");
            }
            tx = await wethContract.withdraw(amount, { gasLimit: 100000, nonce: nonce });
            addLog(`Clober: Đang gửi giao dịch... Hash: ${getShortHash(tx.hash)}`, "clober");
            await tx.wait();
            addLog("Clober: Giao dịch thành công", "success");
            await updateWalletData();
            currentState = "ETH";
          } catch (error) {
            addLog(`Lỗi rút tiền (Clober): ${error.message}`, "error");
          }
        }
      }, `Clober Swap - Vòng thứ ${i}`);

      if (i < loopCount) {
        const delayTime = getRandomDelay();
        const minutes = Math.floor(delayTime / 60000);
        const seconds = Math.floor((delayTime % 60000) / 1000);
        addLog(`Clober Swap: Vòng thứ ${i} hoàn thành. Đang chờ ${minutes} phút ${seconds} giây`, "clober");
        await waitWithCancel(delayTime, "swap");
        if (cloberSwapCancelled) {
          addLog("Clober Swap: Bị dừng trong thời gian chờ.", "clober");
          break;
        }
      }
    }
    cloberSwapRunning = false;
    mainMenu.setItems(getMainMenuItems());
    cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
    safeRender();
    addLog("Clober Swap: Quá trình hoàn tất.", "clober");
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
addLog("Xin chào các bạn, chúc các bạn một ngày vui vẻ !!! @LocalSec", "system");
updateLogs();
updateWalletData();
