import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { gotScraping } from 'got-scraping';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

const PROVIDER = new ethers.JsonRpcProvider('https://bsc-rpc.publicnode.com');

// Задержка между клеймами в секундах.
const DELAY_SECONDS = {
  MIN: 3,
  MAX: 10,
};

// `true` - заклеймить сразу, `false` - заклеймить через 72 часа.
const INSTANT_CLAIM = true;

const wallets = readWallets();

(async () => {
  for (const wallet of wallets) {
    try {
      await processWallet(wallet.wallet, wallet.keypair, wallet.withdrawAddress, wallet.proxy);

      await sleep(DELAY_SECONDS.MIN * 1000, DELAY_SECONDS.MAX * 1000);
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.wallet.address}] Wallet processing error\x1b[0m`);
      console.log();
    }
  }

  console.log('All wallets processed!');
})();

async function processWallet(wallet, keypair, withdrawAddress, proxy) {
  const allocation = await getAllocation(wallet, proxy);
  console.log(`[${wallet.address}] Allocation of ${allocation.amount} JAGER loaded!`);

  if (keypair) {
    const signature = await wallet.signMessage(wallet.address)
    const solanaAddress = keypair.publicKey.toBase58()
    const solanaSignature = signSolMessage(keypair, solanaAddress)
    await bindSolana(proxy, wallet.address, signature, solanaAddress, solanaSignature)
    console.log(`[${wallet.address} Solana address ${solanaAddress} successfully bound`)
  }

  await claim(wallet, allocation);

  if (withdrawAddress) {
    await withdraw(wallet, withdrawAddress);
  }
}

async function withdraw(wallet, withdrawAddress) {
  const contract = getTokenContract(wallet);
  const balance = await contract.balanceOf.staticCall(wallet.address);

  if (balance <= 0n) {
    console.log(`[${wallet.address}] Nothing to withdraw!`);

    return;
  }

  console.log(`[${wallet.address}] Withdraw to ${withdrawAddress}`);

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      const transaction = await contract.transfer(withdrawAddress, balance);

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Withdraw error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Withdrawn ${ethers.formatUnits(balance, 18)} JAGER to ${withdrawAddress} successfully!\x1b[0m`);
}

async function claim(wallet, allocation) {
  const contract = getClaimContract(wallet);
  const claimedAmount = await contract.claimUser.staticCall(wallet.address);

  if (claimedAmount > 0n) {
    console.log(`[${wallet.address}] Already claimed!`);

    return;
  }

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      const transaction = await contract.claim(
        allocation.address,
        ethers.parseUnits(allocation.amount, 18),
        allocation.deadline,
        allocation.sign,
        INSTANT_CLAIM,
        '0xa5b61AF6BC5a24991cf54e835Bdd2C0c4f41D816',
      );

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Claim error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Allocation of ${allocation.amount} JAGER claimed successfully!\x1b[0m`);
}

/**
 * @param {ethers.Wallet} wallet
 * @param {string | undefined} proxy
 * @returns {Promise<{ address: string; amount: string; deadline: number; sign: string }>}
 */
async function getAllocation(wallet, proxy) {
  const response = await gotScraping('https://api.jager.meme/api/airdrop/claimAirdrop', {
    method: 'POST',
    json: {
      address: wallet.address,
      signStr: await wallet.signMessage(wallet.address),
      solAddress: '',
      solSignStr: '',
    },
    proxyUrl: proxy,
    responseType: 'json',
  });

  if (response.ok && response.body?.code === 200 && response.body.data) {
    return response.body.data;
  }

  throw new Error(`No allocation or malformed response (status: ${response.statusCode}): ${response.body?.message}`);
}

async function bindSolana(proxy, address, signature, solanaAddress, solanaSignature) {
  const response = await gotScraping('https://api.jager.meme/api/airdrop/bindSolana', {
    method: 'POST',
    json: {
      address,
      signStr: signature,
      solAddress: solanaAddress,
      solSignStr: solanaSignature
    },
    proxyUrl: proxy,
    responseType: 'json',
  });

  if (response.ok && response.body?.code === 200 && response.body.data) {
    return response.body.data;
  }

  throw new Error(`Failed bind solana address (status: ${response.statusCode}): ${response.body?.message}`);
}

function signSolMessage(keypair, message) {
  const messageBytes = naclUtil.decodeUTF8(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return Buffer.from(signature).toString('base64');
}

function readWallets() {
  const wallets = readFileSync(new URL('./data/wallets.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);
  const proxies = readFileSync(new URL('./data/proxies.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);

  return wallets.map((wallet, index) => {
    const [privateKey, withdrawAddress, solanaPrivateKey] = wallet.trim().split(':');
    let proxy = proxies[index]?.trim() || undefined;

    if (proxy) {
      if (!proxy.includes('@')) {
        const [host, port, username, password] = proxy.split(':');

        proxy = `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
      }

      if (!proxy.includes('://')) {
        proxy = 'http://' + proxy;
      }

      proxy = new URL(proxy).href.replace(/\/$/, '');
    }

    return {
      wallet: new ethers.Wallet(privateKey, PROVIDER),
      keypair: solanaPrivateKey ? Keypair.fromSecretKey(bs58.decode(solanaPrivateKey)) : undefined,
      withdrawAddress: ethers.isAddress(withdrawAddress) ? withdrawAddress : undefined,
      proxy,
    };
  });

  function isNonEmptyLine(line) {
    line = line.trim();

    return line && !line.startsWith('#');
  }
}

function sleep(min, max) {
  const ms = max != null ? Math.floor(Math.random() * (max - min) ) + min : min;

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTokenContract(wallet) {
  const ABI = JSON.parse('[{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"addLPAmount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"addLPETH","type":"uint256"}],"name":"AddLiquidityError","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"spender","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Transfer","type":"event"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"addLiquidity","outputs":[{"internalType":"uint256","name":"amountToken","type":"uint256"},{"internalType":"uint256","name":"amountETH","type":"uint256"},{"internalType":"uint256","name":"liquidity","type":"uint256"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address[]","name":"addr","type":"address[]"},{"internalType":"bool","name":"enable","type":"bool"}],"name":"batchSetFeeWhiteList","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"subtractedValue","type":"uint256"}],"name":"decreaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"feeDistributor","outputs":[{"internalType":"contract FeeDistributor","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"feeWhiteList","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"fundAddres","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCirculatingSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"addedValue","type":"uint256"}],"name":"increaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"mainPair","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"minTaxDistributionThreshold","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"liquidity","type":"uint256"}],"name":"removeLiquidity","outputs":[{"internalType":"uint256","name":"amountToken","type":"uint256"},{"internalType":"uint256","name":"amountETH","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address[]","name":"addr","type":"address[]"},{"internalType":"bool","name":"enable","type":"bool"}],"name":"setExcludeHoldProvider","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"addr","type":"address"},{"internalType":"bool","name":"enable","type":"bool"}],"name":"setSwapPairList","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"addr","type":"address"},{"internalType":"bool","name":"enable","type":"bool"}],"name":"setSwapRouter","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"startTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"swapPairList","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"swapRouters","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"sender","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"weth","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"stateMutability":"payable","type":"receive"}]');

  return new ethers.Contract('0x74836cC0E821A6bE18e407E6388E430B689C66e9', ABI, wallet);
}

function getClaimContract(wallet) {
  const ABI = JSON.parse('[{"inputs":[{"internalType":"address","name":"jager","type":"address"},{"internalType":"address","name":"sign","type":"address"},{"internalType":"address","name":"invitor","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"receiveAmount","type":"uint256"},{"indexed":false,"internalType":"address","name":"firstInvitor","type":"address"},{"indexed":false,"internalType":"uint256","name":"firstAmount","type":"uint256"},{"indexed":false,"internalType":"address","name":"secondInvitor","type":"address"},{"indexed":false,"internalType":"uint256","name":"secondAmount","type":"uint256"},{"indexed":false,"internalType":"bool","name":"instant","type":"bool"}],"name":"Claim","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"instantAmount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"requestRewardAmount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"lpRewardAmount","type":"uint256"}],"name":"InstantClaim","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"pendingReward","type":"uint256"}],"name":"ReceiveToken","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"RequestClaim","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"totalAmount","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"endTime","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"yieldNumber","type":"uint256"}],"name":"StartAirdrop","type":"event"},{"inputs":[],"name":"baseRate","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"calcReceiveAmount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"bytes","name":"sign","type":"bytes"},{"internalType":"bool","name":"instant","type":"bool"},{"internalType":"address","name":"invitor","type":"address"}],"name":"claim","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"claimCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"claimUser","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"defaultInvitor","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"endAirdrop","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"endTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"firstInvitorRate","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"instantRate","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"invitorAmount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"jagerToken","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"lockTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"lpStake","outputs":[{"internalType":"contract JagerHunterLP","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"pendingReward","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"pool","outputs":[{"internalType":"uint256","name":"accLPPerShare","type":"uint256"},{"internalType":"uint256","name":"totalAmount","type":"uint256"},{"internalType":"uint256","name":"totalReward","type":"uint256"},{"internalType":"uint256","name":"holderNum","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"receiveToken","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"receivedAmount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"relation","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"secondInvitorRate","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"signAddress","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"startAirdrop","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"startTime","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalAmount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"userInfo","outputs":[{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"rewardDebt","type":"uint256"},{"internalType":"uint256","name":"pending","type":"uint256"},{"internalType":"uint256","name":"lockEndedTimestamp","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"yieldNumber","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]');

  return new ethers.Contract('0xDF6dbd6d4069bF0c9450538238A9643C72E4a6E4', ABI, wallet);
}
