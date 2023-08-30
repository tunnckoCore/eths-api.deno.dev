import { createPublicClient, http, isAddress } from "https://esm.sh/viem";
import { mainnet } from "https://esm.sh/viem/chains";
import { normalize } from "https://esm.sh/viem/ens";
import pMap from "https://esm.sh/p-map";

import {
  sha256,
  createAccount,
  generatePrivateKey,
  generateMnemonic,
} from "./utils.mjs";

const db = await Deno.openKv();
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(),
});

const MEMORY_RESPONSE_CACHE = {};

/**
 * 1. Get a name (alphanum)
 * 2. Make sha256 of it, useing Web APIs (crypto.subtle.digest and TextEncoder)
 * 3. Get the JSON response from the API: the api.ethscriptions.com/api/ethscriptions/exists/{sha} who's the current_owner.
 * 4. Get the latest profile state from /filtered?creator={owner}&mimetype=application/vnd.esc.user.profile+json
 */

async function fetchFromOrdex(id, eth, network) {
  if (eth) {
    id = eth.transaction_hash;
  }
  if (!eth && id && !id.startsWith("0x") && id.length < 30) {
    eth = await fetch(
      `https://${
        network === "goerli" ? "goerli-" : ""
      }api.ethscriptions.com/api/ethscriptions/${id}`,
    ).then((x) => x.json());

    id = eth.transaction_hash;
  }

  return fetch(`https://api.ordex.ai/v0.1/items/ETHEREUM_ETHSCRIPTION:${id}`)
    .then((x) => {
      if (!x.ok) {
        return {
          meta: {
            content: null,
            rawContent: null,
          },
        };
      }

      return x.json();
    })
    .then((x) => x.meta)
    .then((meta) => ({
      id,
      number: meta.number || eth?.ethscription_number,
      // fallback to what  the OG api gives, cuz.. who knows
      content_uri: meta.rawContent || eth?.content_uri,
      mimetype:
        // weird APIs as fack... some image ethscriptions has `content: []`,
        // others like `text/markdown` has `content: [{ ... no mimetype, @type: "IMAGE" }]` and so on
        (meta.content && meta.content[0] && meta.content[0].mimeType) ||
        eth?.mimetype,
    }));
}

async function patchesAndResolveBanned(x, network) {
  x.id = x.transaction_hash;
  x.ethscription_id = x.id;
  x.timestamp = new Date(x.creation_timestamp).getTime();
  x.current_owner = x.current_owner.toLowerCase();
  x.owner = x.current_owner;
  x.creator = x.creator.toLowerCase();

  if (x.image_removed_by_request_of_rights_holder) {
    const res = await db.get(["banned", x.transaction_hash]);
    let tokenMeta = null;

    if (res.value) {
      tokenMeta = res.value;
    } else {
      // TODO: switch to get it directly from the chain through alchemy/viem & hexed tx.input data
      tokenMeta = await fetchFromOrdex(x.transaction_hash, x, network);

      await db.set(["banned", x.transaction_hash], tokenMeta);
    }

    // false, cuz it's not banned anymore ;d
    x.image_removed_by_request_of_rights_holder = false;

    x.ethscription_number = tokenMeta.number || x.ethscription_number;
    x.mimetype = tokenMeta.mimetype;
    x.content_uri = tokenMeta.content_uri;

    return x;
  }

  return x;
}

async function resolve(val, network = "mainnet") {
  if (isAddress(val)) {
    const ethscriptionProfile = await getLatestProfileState(val, network);
    if (!ethscriptionProfile) {
      console.log("no user profile configured");
      return { address: val };
    }

    const profile = await parseProfile(ethscriptionProfile);

    return { ...profile, address: val };
  }

  if (val.endsWith(".eth")) {
    const ensAddress = await publicClient.getEnsAddress({
      name: normalize(val),
    });

    if (ensAddress) {
      const ethscriptionProfile = await getLatestProfileState(
        ensAddress,
        network,
      );
      if (!ethscriptionProfile) {
        return { address: ensAddress };
      }
      const profile = await parseProfile(ethscriptionProfile);
      return { ...profile, address: ensAddress };
    }
  }

  const sha = await sha256(`data:,${val}`);
  const exists = await checkExists(sha);
  if (!exists) {
    console.log("not exists");
    return;
  }

  const ethscriptionProfile = await getLatestProfileState(
    exists.current_owner,
    network,
  );
  if (!ethscriptionProfile) {
    return { address: exists.current_owner };
  }
  const profile = await parseProfile(ethscriptionProfile);
  return { ...profile, address: exists.current_owner };
}

// console.log(await resolve("tunnckocore.eth"));
// console.log(await resolve("somebluenekowallet"));
// console.log(await resolve("wgw.lol"));
// console.log(await resolve("hirsch"));

async function checkExists(sha) {
  const response = await fetch(
    `https://api.ethscriptions.com/api/ethscriptions/exists/${sha}`,
  );
  const json = await response.json();
  if (json.result) {
    return json.ethscription;
  }
  return false;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
};

const cacheHeaders = {
  // 7 days
  "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
};

async function getLatestProfileState(owner, network = "mainnet") {
  const response = await fetch(
    `https://${
      network === "mainnet" ? "" : "goerli-"
    }api.ethscriptions.com/api/ethscriptions/filtered?creator=${owner}&mimetype=${encodeURIComponent(
      "application/vnd.esc.user.profile+json",
    )}`,
  );
  const { ethscriptions } = await response.json();

  return ethscriptions[0];
}

async function resolveCached(key, network = "mainnet") {
  const res = await db.get(["resolved_by_name", key]);
  let profile = null;
  if (res.value) {
    profile = res.value;
  } else {
    const resolved = await resolve(key, network);
    resolved.address = resolved.address.toLowerCase();
    profile = resolved;
    await db.set(["resolved_by_name", key], resolved);
  }

  return profile;
}

async function parseProfile(ethscription) {
  const uri = ethscription.content_uri.replace(
    "data:application/vnd.esc.user.profile+json",
    "",
  );
  const base64index = uri.indexOf(";base64,");

  if (base64index > -1) {
    return JSON.parse(atob(uri.slice(base64index)));
  }

  return JSON.parse(uri.slice(1));
}

const networks = ["mainnet", "goerli"];
const versions = ["v1"];
const mainEndpoints = [
  "/profiles - track latest 'profiles' ethscriptions",
  "/profiles/{address_or_ens_or_handle} - changes of user's profile",
  "/profiles/{address_or_ens_or_handle}?filters=here",
  "/profiles/{address_or_ens_or_handle}/info - only the latest profile state, supports filters too",
  "/profiles/{address_or_ens_or_handle}/created - only the ethscriptions created by the user, supports filters too",
  "/profiles/{address_or_ens_or_handle}/owned - only ethscriptionns owned by the user, supports filters too. Alias of /eths/owned_by/{address_or_ens_or_handle}",
  "",
  "/collections - list of all collections",
  "/collections/{collection_name} - get collection by name",
  "/ethscriptions - alias of /eths",
  "",
  "/eths - all latest ethscriptions, alias of /eths/filtered",
  "/eths/exists/{sha} - get ethscription by sha256 of the content_uri",
  "/eths/filtered?filters=here - use `only=creator,id,timestamp` to get only those fields; use `without=creator,id` to get all fields except those; use `mimetype={mimetype}` to get only ethscriptions with this mimetype",
  "/eths/owned_by/{address_or_ens_or_handle} - ethscriptionns owned by user",
  "/eths/{ethscription_id_or_number} - get ethscription by id or number",
  "/eths/{ethscription_id_or_number}/sha - get ethscription and it's sha",
];

const endpoints = networks.reduce(
  (acc, network) => {
    mainEndpoints.forEach((endpoint) => {
      versions.forEach((v) => {
        if (endpoint === "") {
          acc.push("");
        } else {
          acc.push(`/${v}/${network}${endpoint}`);
        }
      });
    });
    acc.push("", "");

    return acc;
  },
  [
    "/v1/sha?of={dataURI} - create sha256 of a given data URI or text; if it starts with `data:`, it will be used as is; otherwise, you can additionally pass `type` and/or `isBase64` query params",
    "/v1/snapshot/{collection_name} - can take a while (~1min per 10k); create a snapshot of a given collection; possible `only=` filters: holders, creators, items, stats, unique",
    "",
  ],
);

async function delay(ms = 300) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAndCreateSnapshot(collectionName, params) {
  // fetch directly from the official API
  let result = null;

  const url = `https://api.ethscriptions.com/api/ethscriptions/filtered?collection=${collectionName}`;

  try {
    result = await fetch(url)
      .then((x) => {
        if (!x.ok) {
          throw new Error(
            `Failing to fetch from the upstream official API. Status: ${x.status} - ${x.statusText}`,
          );
        }

        return x;
      })
      .then((x) => x.json());
  } catch (error) {
    console.log("err creating snapshot for %s:", collectionName, error);

    return Response.json(
      {
        error: `Failed to create snapshot for ${collectionName}: ${error.message}`,
      },
      { status: 200, headers: { ...corsHeaders } },
    );
  }

  const pages = Math.ceil(result.total_count / 25) - 2;
  const unique = { holders: [], creators: [] };

  const mapper = (item) => {
    if (!unique.holders.includes(item.current_owner.toLowerCase())) {
      unique.holders.push(item.current_owner.toLowerCase());
    }
    if (!unique.creators.includes(item.creator.toLowerCase())) {
      unique.creators.push(item.creator.toLowerCase());
    }

    return {
      id: item.transaction_hash.toLowerCase(),
      owner: item.current_owner.toLowerCase(),
      creator: item.creator.toLowerCase(),
    };
  };

  const data = result.ethscriptions.map(mapper);

  console.log("all pages:", pages);
  console.log("all items:", result.total_count);

  // we already have the first and second page (by default gives 50 results, 0 and 1 is the same page)

  await pMap(
    Array(pages)
      .fill(0)
      .map((_, i) => i + 3),
    async (pageNum) => {
      const resp = await fetch(url + `&page=${pageNum}`).then((x) => x.json());

      const items = resp.ethscriptions.map(mapper);
      data.push(...items);
      // await delay(300);
      console.log(`Fetched page %s for %s`, pageNum, collectionName);
      // console.log("first item of page %s:", pageNum, items[0]);
    },
    { concurrency: 15 },
  );

  const keys = params.only ? params.only.split(",") : [];
  const fullData = { unique, items: data };
  let resultData = fullData;

  for (const key of keys) {
    if (key === "holders" || key === "owners") {
      resultData = { [key]: fullData.unique.holders };
    }
    if (key === "creators") {
      resultData = { [key]: fullData.unique.creators };
    }
    if (key === "items") {
      resultData = { [key]: fullData.items };
    }
    if (key === "unique") {
      resultData = { [key]: fullData.unique };
    }
  }

  if (keys.includes("stats")) {
    resultData = null;
  }

  const timestamp = Date.now();

  return Response.json(
    {
      total_count: data.length,
      snapshot_timestamp: timestamp,
      snapshot_date: new Date(timestamp),
      collection: collectionName,
      unique_holders_count: unique.holders.length,
      unique_creators_count: unique.creators.length,
      data: resultData,
    },
    { status: 200, headers: { ...corsHeaders } },
  );
}

Deno.serve(async (req) => {
  let url = new URL(req.url, "https://api.ethscriptions.com");
  const params = Object.fromEntries(url.searchParams.entries());

  if (url.pathname === "/clear-db") {
    const iter = db.list({ prefix: [] });

    for await (const { key } of iter) {
      console.log("deleting", key);
      await db.delete(key);
    }

    return Response.json(
      { deleted: true },
      {
        status: 200,
        headers: { ...corsHeaders },
      },
    );
  }

  if (req.method.toUpperCase() === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Content-Length": 0, ...corsHeaders },
    });
  }

  if (url.pathname === "/") {
    return Response.json(
      {
        message:
          "Welcome to the ethscriptions API. 🎉 It's a proxy with few patches of the official one, like including banned content URIs, automatic resolving ethscriptions handles/domains & ENS names, versioning, and unified response format.",
        networks,
        versions,
        endpoints: endpoints.slice(0, -2),
      },
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const network = url.pathname.split("/")[2];
  let unversionedPathname = url.pathname
    .replace(`/v1/${network}`, "/api")
    .replace(/\/eths$/, "/ethscriptions");
  unversionedPathname = unversionedPathname.replace(/\/$/, "");

  let data = null;
  let result = req;
  let resolvedProfile = null;

  try {
    if (url.pathname.endsWith("generate-account")) {
      const data = createAccount();
      return Response.json(
        { data },
        { status: 200, headers: { ...corsHeaders } },
      );
    }
    if (url.pathname.endsWith("generate-private-key")) {
      const data = generatePrivateKey();
      return Response.json(
        { data },
        { status: 200, headers: { ...corsHeaders } },
      );
    }
    if (url.pathname.endsWith("generate-mnemonic")) {
      const data = generateMnemonic();
      return Response.json(
        { data },
        { status: 200, headers: { ...corsHeaders } },
      );
    }

    if (
      url.pathname.includes("ethscriptions") &&
      /(content|data)$/i.test(url.pathname)
    ) {
      unversionedPathname = unversionedPathname.replace("/content", "/data");

      const id = unversionedPathname.split("/")[3];
      const { content_uri } = await fetchFromOrdex(id);

      if (params.noscale) {
        return fetch(content_uri);
      }

      const newPathname = unversionedPathname
        .replace("/ethscriptions", "/ethscriptions/png")
        .replace("/data", "")
        .replace("/content", "");

      // https://app.indelible.xyz/api/ethscriptions/png/{hash_or_number}
      const newUrl = new URL(`https://app.indelible.xyz${newPathname}`);

      if (MEMORY_RESPONSE_CACHE[newUrl.toString()]) {
        const item = MEMORY_RESPONSE_CACHE[newUrl.toString()];

        return new Response(item.body, item.init);
      }

      const resp = await fetch(newUrl);

      if (!resp.ok) {
        console.log(resp);
        throw new Error("Upscaling failure");
      }

      const item = {
        body: await resp.blob(),
        init: {
          headers: {
            ...resp.headers,
            ...corsHeaders,
            ...cacheHeaders,
          },
        },
      };

      MEMORY_RESPONSE_CACHE[newUrl.toString()] = item;

      return new Response(item.body, item.init);
    }

    if (
      unversionedPathname.includes("ethscriptions/") &&
      unversionedPathname.endsWith("/sha")
    ) {
      const parts = unversionedPathname.split("/");
      const eth = parts[parts.length - 2];

      const { mimetype, content_uri, id, number } = await fetchFromOrdex(eth);

      const sha = await sha256(content_uri);
      const full = params.full
        ? {
            mimetype,
            content_uri,
            ethscription_number: number,
            transaction_hash: id,
          }
        : {};

      return Response.json(
        {
          data: {
            sha,
            id,
            ...full,
          },
        },
        { status: 200, headers: { ...corsHeaders, ...cacheHeaders } },
      );
    }

    if (params.creator) {
      if (isAddress(params.creator)) {
        params.creator = params.creator.toLowerCase();
      } else {
        resolvedProfile = await resolveCached(params.creator, network);
        params.creator = resolvedProfile.address.toLowerCase();
      }
    }
    if (params.current_owner) {
      if (isAddress(params.current_owner)) {
        params.current_owner = params.current_owner.toLowerCase();
      } else {
        resolvedProfile = await resolveCached(params.current_owner, network);
        params.current_owner = resolvedProfile.address.toLowerCase();
      }
    }

    if (url.pathname.includes("/v1/sha") && params.of) {
      const type = params.mimetype || params.type || "";
      const msg = params.of.startsWith("data")
        ? params.of
        : `data:${type}${params.isBase64 ? ";base64," : ","}${params.of}`;

      const sha = await sha256(msg);

      return Response.json(
        { data: { sha } },
        { status: 200, headers: { ...corsHeaders /* ...cacheHeaders */ } },
      );
    }

    if (url.pathname.includes("/v1/snapshot/")) {
      const parts = unversionedPathname.split("/");
      const collectionName = parts[parts.length - 1];

      return fetchAndCreateSnapshot(collectionName, params);
    }

    if (unversionedPathname.includes("ethscriptions/owned_by")) {
      const parts = unversionedPathname.split("/");
      const owner = parts[parts.length - 1];
      let resolvedAddress = null;

      if (isAddress(owner)) {
        resolvedAddress = owner.toLowerCase();
      } else {
        resolvedProfile = await resolveCached(owner, network);
        resolvedAddress = resolvedProfile.address.toLowerCase();
      }

      unversionedPathname = unversionedPathname.replace(
        `owned_by/${owner}`,
        `filtered?current_owner=${resolvedAddress}`,
      );
    }

    if (unversionedPathname.endsWith("ethscriptions")) {
      unversionedPathname = unversionedPathname.replace(
        "ethscriptions",
        "ethscriptions/filtered",
      );
    }

    if (unversionedPathname.includes("/profiles")) {
      const isInfo = unversionedPathname.endsWith("/info");
      const isCreated = unversionedPathname.endsWith("/created");
      const isOwned = unversionedPathname.endsWith("/owned");
      const isAll = /profiles$/.test(unversionedPathname);
      const parts = unversionedPathname.split("/");
      const user =
        isInfo || isCreated || isOwned
          ? parts[parts.length - 2]
          : parts[parts.length - 1];

      let userAddress = null;

      if (!isAll) {
        if (isAddress(user)) {
          userAddress = user.toLowerCase();
        } else {
          resolvedProfile = await resolveCached(user, network);
          userAddress = resolvedProfile.address.toLowerCase();
        }
      }

      if (isInfo || isAll) {
        unversionedPathname = unversionedPathname.replace(
          isAll ? "profiles" : `profiles/${user}/info`,
          `ethscriptions/filtered?${
            isAll ? "" : "creator=" + userAddress + "&"
          }mimetype=${encodeURIComponent(
            "application/vnd.esc.user.profile+json",
          )}`,
        );
      } else if (isCreated) {
        unversionedPathname = unversionedPathname.replace(
          `profiles/${user}/created`,
          `ethscriptions/filtered?creator=${userAddress}`,
        );
      } else {
        unversionedPathname = unversionedPathname.replace(
          `profiles/${user}`,
          `ethscriptions/filtered?current_owner=${userAddress}`,
        );

        unversionedPathname = isOwned
          ? unversionedPathname.replace("/owned", "")
          : unversionedPathname;
      }
    }

    const searchParams = new URLSearchParams(params);
    const newUrl = new URL(
      `https://${
        network === "goerli" ? "goerli-" : ""
      }api.ethscriptions.com${unversionedPathname}${
        searchParams.size
          ? (unversionedPathname.includes("?") ? "&" : "?") +
            searchParams.toString()
          : ""
      }`,
    );

    // console.log({ newUrl, unversionedPathname, resolvedProfile, url });

    result = await fetch(newUrl)
      .then((x) => {
        if (!x.ok) {
          throw new Error(
            `Failing to fetch from the upstream official API. Status: ${x.status} - ${x.statusText} ! ${newUrl}`,
          );
        }

        return x;
      })
      .then(async (x) => ({
        data: await x.json(),
        headers: x.headers,
        status: x.status,
      }));

    data = await patchItems(result, { newUrl, resolvedProfile, network, url });
    data = withAdditionalFilters(params, data);
  } catch (error) {
    console.log("err:", error);
    return Response.json(
      { error: error.message },
      { status: 200, headers: { ...corsHeaders } },
    );
  }

  return Response.json(data, {
    headers: { ...result?.headers, ...corsHeaders },
    status: result?.status,
  });
});

async function patchItems(result, { newUrl, resolvedProfile, network, url }) {
  let json = null;
  let pathname = newUrl.pathname;

  if (/ethscriptions\/?$/i.test(pathname)) {
    const fp = pathname.endsWith("/") ? pathname : pathname + "/";
    pathname = fp.replace("ethscriptions/", "ethscriptions/filtered");
  }

  if (pathname.includes("ethscriptions/filtered")) {
    const ethscriptions = await Promise.all(
      result.data.ethscriptions.map((x) => patchesAndResolveBanned(x, network)),
    );

    json = {
      total_count: result.data.total_count,
      response_count: result.data.response_count,
      data: ethscriptions,
    };

    if (
      newUrl.search.includes("mimetype=application") &&
      newUrl.search.includes("vnd.esc.user.profile")
    ) {
      if (newUrl.search.includes("all") || /profiles$/.test(url.pathname)) {
        json = {
          ...json,
          data: json.data.map((x) => ({
            ...x,
            profile: JSON.parse(
              x.content_uri
                .trim()
                .replace("data:application/vnd.esc.user.profile+json,", ""),
            ),
          })),
        };
      } else {
        json = {
          total_count: result.data.total_count,
          response_count: result.data.total_count === 0 ? 0 : 1,
          data: { ...ethscriptions[0], profile: resolvedProfile },
        };
      }
    }
  } else if (pathname.includes("ethscriptions/exists")) {
    const ethscription = result.data.result
      ? await patchesAndResolveBanned(result.data.ethscription, network)
      : null;
    json = { exists: result.data.result, data: ethscription };
  } else if (/collections\/?$/i.test(pathname)) {
    json = {
      total_count: result.data.length,
      data: result.data.sort((a, b) => a.id - b.id),
    };
  } else if (/collections\/?.+$/i.test(pathname)) {
    json = {
      data: result.data,
    };
  } else {
    console.log("single ethscription endpoint");
    json = { data: await patchesAndResolveBanned(result.data, network) };
  }

  return json;
}

function withAdditionalFilters(params, data) {
  if (params.only || params.without) {
    const keys = params.only
      ? params.only.split(",")
      : params.without.split(",");

    if (Array.isArray(data.data)) {
      data.data = data.data.reduce((acc, ethscription) => {
        let obj = ethscription;

        if (params.only) {
          obj = keys.reduce((accel, key) => {
            accel[key] = ethscription[key];
            return accel;
          }, {});
        } else if (params.without) {
          obj = Object.keys(ethscription).reduce((accel, key) => {
            if (!keys.includes(key)) {
              accel[key] = ethscription[key];
            }
            return accel;
          }, {});
        }

        return acc.concat(obj);
      }, []);
    } else if (typeof data === "object" && data) {
      if (params.only) {
        data.data = keys.reduce((acc, key) => {
          acc[key] = data.data[key];
          return acc;
        }, {});
      } else if (params.without) {
        data.data = Object.keys(data.data).reduce((acc, key) => {
          if (!keys.includes(key)) {
            acc[key] = data.data[key];
          }
          return acc;
        }, {});
      }
    }
  }

  return data;
}
