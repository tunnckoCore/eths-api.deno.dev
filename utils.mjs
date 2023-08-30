import { toHex } from "https://esm.sh/viem";
import * as viemAccounts from "https://esm.sh/viem/accounts";

export function generateMnemonic() {
  return viemAccounts.generateMnemonic(viemAccounts.english);
}

export function generatePrivateKey() {
  return viemAccounts.generatePrivateKey();
}

export async function toBase64usingFileReader(
  bytesOrString,
  type = "application/octet-stream"
) {
  return new Promise((resolve, reject) => {
    const reader = Object.assign(new FileReader(), {
      onload: () => resolve(reader.result.replace(`data:${type};base64,`, "")),
      onerror: () => reject(reader.error),
    });
    reader.readAsDataURL(new File([bytesOrString], "", { type }));
  });
}

export async function fromBase64usingFetch(
  b64str,
  type = "application/octet-stream"
) {
  const res = await fetch(`data:${type};base64,${b64str}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function toBase64(msg) {
  const binString = Array.from(
    typeof msg === "string" ? new TextEncoder().encode(msg) : msg,
    (x) => String.fromCodePoint(x)
  ).join("");

  return btoa(binString);
}

export async function sha256(msg) {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    typeof msg === "string" ? new TextEncoder().encode(msg) : msg
  );

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
}

export function createAccount(mnemonicOrPrivateKey) {
  const seed = mnemonicOrPrivateKey || generateMnemonic();
  const fromPrivateKey = seed.startsWith("0x") && !seed.includes(" ");
  const account = fromPrivateKey
    ? viemAccounts.privateKeyToAccount(seed)
    : viemAccounts.mnemonicToAccount(seed);

  return {
    address: account.address,
    publicKey: account.publicKey,
    privateKey: fromPrivateKey ? seed : toHex(account.getHdKey().privKeyBytes),
    mnemonic: fromPrivateKey ? null : seed,
  };
}

// const creator = mnemonicToAccount(
//   `neck hood arena urban cook stand mimic knife page taste select secret`
// );

// const acc = createAccount();

// console.log(acc);

// console.log(toBase64("foo bar"));

// console.log(genPrivateKey());
