// DataroomModal.jsx — the secure investor dataroom for one deal. The operator
// builds a package from the offer, then issues one personal link per investor
// and texts it through GHL.
//
// The thing to understand about this screen: a link's token exists only in the
// response that mints it. The server keeps a hash, so nothing here can show a
// link again later — if it scrolls away, reissue it (which also kills the old
// one). That's why freshly-minted links get pinned to the top with a copy
// button until dismissed.
//
// The deal strip along the top lets the operator move between active deals (and
// see where investors are actually looking) without closing back to the board.

import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Eye, ImagePlus, Loader2, Lock, Play, Plus, RefreshCw, Send, ShieldOff,
  Star, Trash2, Video, X,
} from "lucide-react";
import { fmtMoney } from "@shared/offer-calc.js";
import {
  beginOfferVideo, completeOfferVideo, createDataroom, createDataroomInvite, deleteOfferPhoto,
  deleteOfferVideo, expandDriveFolder, fetchOfferPhotoFromUrl, getDataroom, getDataroomPortfolio,
  listDatarooms, listOfferPhotos, listOfferVideos, offerPhotoUrl, offerVideoPosterUrl,
  offerVideoStreamUrl, reissueDataroomInvite, reorderOfferPhotos,
  revokeDataroom, revokeDataroomInvite, rotateDataroomShareLink, searchContacts,
  sendDataroomInvite, updateDataroom, uploadOfferPhoto, uploadOfferVideoPart,
} from "./api.js";
import { propertyPhotoVariants } from "./image.js";
import { probeVideo } from "./video.js";
import { CopyButton } from "./ui.jsx";

// One ceiling for every way photos arrive — picked, dropped, pasted, or named
// by a Drive folder. Uploads are sequential, so this is a patience limit.
const MAX_PHOTOS_PER_IMPORT = 100;

// Client-side twin of parseDriveFolderId in ghl-broker/drive-folder.js, and
// only a shape check: it decides whether a link is worth asking the broker to
// expand. The broker re-parses and is the one that actually decides.
const isDriveFolderUrl = (u) =>
  /^https?:\/\/(www\.)?drive\.google\.com\/(.*\/)?folders\/[A-Za-z0-9_-]{10,}/.test(String(u).trim());

const LABEL_CLS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
const INPUT_CLS =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-60";
const BTN_CLS =
  "flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50";

// Order here is the order the toggles appear. feeBreakdown is last and framed
// as a warning — it shows the investor our contract price and our fee.
const SECTIONS = [
  ["summary", "Headline numbers", "Purchase price, ARV, rehab"],
  ["property", "Property details", "Beds, baths, sqft, year"],
  ["equity", "Spread at ARV", "ARV minus price and rehab"],
  ["comps", "Comparable sales", "The comps behind the ARV"],
  ["scope", "Rehab scope of work", "Line-item budget"],
  ["terms", "Terms", "Closing and inspection dates"],
  ["documents", "Documents", "Comps + scope PDFs"],
  ["feeBreakdown", "Price breakdown", "Reveals your contract price and fee"],
];

// What can go on the tokenless public teaser page. Documents and the price
// breakdown aren't offered — the server locks them off no matter what.
const PUBLIC_SECTIONS = [
  ["summary", "Headline numbers"],
  ["equity", "Spread at ARV"],
  ["photos", "Photos & video"],
  ["comps", "Comparable sales"],
  ["scope", "Rehab scope"],
  ["terms", "Terms"],
];

const shortDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
// Street line only — the deal strip has no room for city/state/zip.
const shortAddress = (a) => String(a || "Deal").split(",")[0].trim() || "Deal";

// Typeahead over GHL contacts — same debounced shape as DealsView's picker.
function ContactPicker({ existingIds, onPick, busy }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) { setResults([]); return; }
    timer.current = setTimeout(() => {
      setSearching(true);
      searchContacts(query.trim()).then(setResults).catch(() => setResults([])).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div className="relative">
      <input value={query} disabled={busy} className={INPUT_CLS}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Invite an investor — search your GHL contacts…" />
      {searching && <Loader2 size={14} className="absolute right-3 top-3 animate-spin text-slate-400" />}
      {open && results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.map((c) => (
            <button key={c.id} type="button" disabled={existingIds.has(c.id)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(c); setQuery(""); setResults([]); setOpen(false); }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
              <span className="font-medium">{c.name || "(no name)"}</span>
              <span className="text-xs text-slate-500">{[c.phone, c.email].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// A link that was just minted. Shown once — dismissing it is the only way to
// clear it, and after that only a reissue can produce a working link.
function FreshLink({ item, onSend, onDismiss, busy }) {
  return (
    <div className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-semibold text-emerald-900">
          Link for {item.name || "this investor"} — shown once
        </div>
        <button type="button" onClick={onDismiss} className="rounded p-1 text-emerald-700 hover:bg-emerald-100">
          <X size={14} />
        </button>
      </div>
      <p className="mt-0.5 text-xs text-emerald-800">
        We store only a hash of this link, so it can't be shown again. Text it now, or copy it somewhere safe.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input readOnly value={item.link} className="w-full rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 font-mono text-xs" />
        <CopyButton value={item.link} className={`${BTN_CLS} shrink-0 border-emerald-300 bg-white`} />
      </div>
      {item.sendResult?.dryRun && (
        <div className="mt-2 rounded-lg bg-white/70 p-2 text-xs text-emerald-900">
          <div className="font-semibold">Test mode — nothing was texted.</div>
          <div className="mt-1 whitespace-pre-wrap text-slate-600">{item.sendResult.preview?.message}</div>
        </div>
      )}
      {item.sendResult?.sent && <div className="mt-2 text-xs font-semibold text-emerald-800">Texted to {item.phone}.</div>}
      {item.sendResult?.results?.link?.error && (
        <div className="mt-2 text-xs font-semibold text-red-700">Text failed: {item.sendResult.results.link.error}</div>
      )}
      {!item.sendResult && item.phone && (
        <button type="button" disabled={busy} onClick={onSend}
          className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
          <Send size={13} /> Text it to {item.name?.split(" ")[0] || "them"}
        </button>
      )}
    </div>
  );
}

// The three figures on the investor's headline strip, editable right here. Each
// follows the offer until the operator types a number, which pins it on the
// room: the offer can move and the room keeps saying what was typed. "Follow
// the offer" unpins it. Spread is never typed — it's the other three, and
// showing it live is how the operator sees what a change does before an
// investor does. Contract price isn't offered: that's the signed agreement,
// and a pinned purchase price moves the fee, not the contract.
const HEADLINE_FIGURES = [
  ["investorPrice", "Purchase price", "What the investor pays — contract price plus your fee"],
  ["arv", "After-repair value", ""],
  ["repairs", "Est. rehab", ""],
];

function MoneyField({ value, pinned, disabled, onSave, onUnpin, label, hint }) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : (value > 0 ? fmtMoney(value) : "");
  const commit = () => {
    setEditing(false);
    const v = Math.round(Number(String(text).replace(/[^0-9.]/g, "")));
    if (!Number.isFinite(v) || v === Math.round(Number(value) || 0)) return;
    onSave(v);
  };
  return (
    <div>
      <span className={LABEL_CLS}>{label}</span>
      <input className={`${INPUT_CLS} tabular-nums`} inputMode="numeric" value={shown} disabled={disabled}
        placeholder="—"
        onFocus={() => { setText(value > 0 ? String(Math.round(value)) : ""); setEditing(true); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } if (e.key === "Escape") { setEditing(false); e.target.blur(); } }} />
      <span className="mt-0.5 block text-[11px] text-slate-500">
        {pinned ? (
          <>
            <span className="font-semibold text-amber-700">Set here</span>
            {" · "}
            <button type="button" disabled={disabled} onClick={onUnpin} className="text-blue-700 hover:underline disabled:opacity-50">
              Follow the offer
            </button>
          </>
        ) : (hint || "Follows the offer")}
      </span>
    </div>
  );
}

function HeadlineNumbers({ room, busy, onSave }) {
  const n = room?.snapshot?.numbers || {};
  const pins = room?.snapshot?.overrides || {};
  const spread = Math.round((Number(n.arv) || 0) - (Number(n.investorPrice) || 0) - (Number(n.repairs) || 0));
  return (
    <div className="mt-3">
      <span className={LABEL_CLS}>Headline numbers</span>
      <div className="grid gap-3 sm:grid-cols-4">
        {HEADLINE_FIGURES.map(([key, label, hint]) => (
          <MoneyField key={key} label={label} hint={hint} value={n[key]} pinned={pins[key] > 0} disabled={busy}
            onSave={(v) => onSave({ numbers: { [key]: v } })}
            onUnpin={() => onSave({ numbers: { [key]: null } })} />
        ))}
        <div>
          <span className={LABEL_CLS}>Spread at ARV</span>
          <div className={`rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold tabular-nums ${spread > 0 ? "text-emerald-700" : "text-slate-400"}`}>
            {n.arv > 0 && n.investorPrice > 0 ? fmtMoney(spread) : "—"}
          </div>
          <span className="mt-0.5 block text-[11px] text-slate-500">ARV minus price and rehab</span>
        </div>
      </div>
      {n.contractPrice > 0 && (
        <p className="mt-1.5 text-xs text-slate-500">
          Contract price {fmtMoney(n.contractPrice)} · your fee {fmtMoney(n.assignmentFee)}. Typing a purchase price moves the fee, not the contract.
        </p>
      )}
    </div>
  );
}

// Videos for one deal — the walkthrough the operator shot on their phone. They
// belong to the offer like photos do, and the investor page reads them live,
// where they sit in the gallery as poster tiles and play inside the viewer.
//
// A clip is a few hundred MB, so it goes up in parts: one request per part,
// which means a flaky connection retries a part rather than the file, and the
// bar below shows real progress rather than a spinner.
const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";
const fmtClock = (secs) => {
  const t = Math.max(0, Math.round(Number(secs) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

function VideosPane({ offerId, busy, setBusy, onError }) {
  const [videos, setVideos] = useState(null);
  const [progress, setProgress] = useState(null); // { name, pct } | { name, label }
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setVideos(null);
    listOfferVideos(offerId)
      .then((v) => { if (!cancelled) setVideos(v); })
      .catch(() => { if (!cancelled) setVideos([]); });
    return () => { cancelled = true; };
  }, [offerId]);

  async function addFile(file) {
    if (!file) return;
    setBusy(true);
    onError("");
    let started = null;
    try {
      setProgress({ name: file.name, label: "Reading the video…" });
      const meta = await probeVideo(file);
      // Safari reports .mov as video/quicktime; some browsers report nothing
      // at all for it, so fall back to the extension.
      const contentType = file.type
        || (/\.mov$/i.test(file.name) ? "video/quicktime" : /\.webm$/i.test(file.name) ? "video/webm" : "video/mp4");
      const { video, partBytes } = await beginOfferVideo(offerId, { name: file.name, contentType, sizeBytes: file.size });
      started = video;
      const total = Math.ceil(file.size / partBytes);
      const parts = [];
      for (let n = 1; n <= total; n++) {
        const slice = file.slice((n - 1) * partBytes, Math.min(file.size, n * partBytes));
        // One retry per part: a dropped connection mid-upload is the common
        // failure, and recovering costs one part, not the file.
        let etag;
        try { etag = await uploadOfferVideoPart(offerId, video.id, n, slice); }
        catch { etag = await uploadOfferVideoPart(offerId, video.id, n, slice); }
        parts.push({ n, etag });
        setProgress({ name: file.name, pct: Math.round((n / total) * 100) });
      }
      setProgress({ name: file.name, label: "Finishing…" });
      await completeOfferVideo(offerId, video.id, { parts, ...meta });
      started = null;
      setVideos(await listOfferVideos(offerId));
    } catch (e) {
      // A half-sent video is worse than none: the list would show a ghost.
      if (started) await deleteOfferVideo(offerId, started.id).catch(() => {});
      onError(e.message);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  const remove = async (id) => {
    setBusy(true);
    onError("");
    try { setVideos(await deleteOfferVideo(offerId, id)); } catch (e) { onError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="mb-4 rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={`${LABEL_CLS} mb-0`}>Property videos</span>
        <span className="text-xs text-slate-500">
          {progress ? (progress.label || `Uploading ${progress.name} · ${progress.pct}%`)
            : videos?.length ? `${videos.length} video${videos.length === 1 ? "" : "s"} · shown with the photos`
            : ""}
        </span>
      </div>
      {progress?.pct != null && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${progress.pct}%` }} />
        </div>
      )}
      {videos === null ? (
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-slate-400" /></div>
      ) : (
        <>
          {videos.length > 0 && (
            <div className="mb-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {videos.map((v) => (
                <div key={v.id} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                  {v.status === "ready" ? (
                    <a href={offerVideoStreamUrl(offerId, v.id)} target="_blank" rel="noopener noreferrer" title="Play in a new tab">
                      <img src={offerVideoPosterUrl(offerId, v.id, "thumb")} alt="" loading="lazy"
                        className="block aspect-[3/2] w-full object-cover" />
                      <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white">
                        <Play size={9} className="fill-current" />{v.durationS ? fmtClock(v.durationS) : "Video"}
                      </span>
                    </a>
                  ) : (
                    <div className="flex aspect-[3/2] items-center justify-center px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Upload didn't finish
                    </div>
                  )}
                  <div className="absolute inset-x-0 top-0 flex justify-end bg-slate-900/70 p-1 opacity-0 transition group-hover:opacity-100">
                    <button type="button" disabled={busy} title="Delete this video" onClick={() => remove(v.id)}
                      className="rounded px-1 text-white hover:bg-red-500/70 disabled:opacity-30"><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} className={BTN_CLS} onClick={() => fileRef.current?.click()}>
              {progress ? <Loader2 size={13} className="animate-spin" /> : <Video size={13} />}
              {videos.length ? "Add another video" : "Add a video"}
            </button>
            <input ref={fileRef} type="file" accept={VIDEO_ACCEPT} className="hidden"
              onChange={(e) => { addFile(e.target.files?.[0]); e.target.value = ""; }} />
            <span className="text-xs text-slate-500">MP4, MOV or WebM · up to 500 MB</span>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            A walkthrough shows up with the photos and plays inside the viewer on the investor page. For the widest
            playback, shoot in "Most Compatible" (H.264) or export as MP4 — an iPhone's default HEVC clip won't play
            on every Android phone or PC.
          </p>
        </>
      )}
    </div>
  );
}

// Photos for one deal. They belong to the OFFER, so they survive rebuilding or
// re-sending the package — and the investor page reads them live, which is why
// a delete here disappears from every link immediately.
//
// Order is the whole interface: photo #1 is the hero on the deal page and the
// thumbnail on the all-deals page. There's no separate "hero" flag to drift.
function PhotosPane({ offerId, busy, setBusy, onError }) {
  const [photos, setPhotos] = useState(null);
  const [uploading, setUploading] = useState(null); // {done, total}
  const [dragging, setDragging] = useState(false);
  const [photoUrl, setPhotoUrl] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setPhotos(null);
    listOfferPhotos(offerId)
      .then((p) => { if (!cancelled) setPhotos(p); })
      .catch(() => { if (!cancelled) setPhotos([]); });
    return () => { cancelled = true; };
  }, [offerId]);

  const guard = async (fn) => {
    setBusy(true);
    onError("");
    try { setPhotos(await fn()); } catch (e) { onError(e.message); } finally { setBusy(false); }
  };

  async function addFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith("image/")).slice(0, MAX_PHOTOS_PER_IMPORT);
    if (!list.length) return;
    setBusy(true);
    onError("");
    setUploading({ done: 0, total: list.length });
    const failures = [];
    // Sequential: each photo is its own request, and a phone photo set is big
    // enough that firing them all at once just makes the broker queue anyway.
    for (const [i, file] of list.entries()) {
      try {
        await uploadOfferPhoto(offerId, await propertyPhotoVariants(file));
      } catch (e) {
        failures.push(`${file.name}: ${e.message}`);
      }
      setUploading({ done: i + 1, total: list.length });
    }
    try { setPhotos(await listOfferPhotos(offerId)); } catch { /* keep what we have */ }
    setUploading(null);
    setBusy(false);
    if (failures.length) onError(`${failures.length} photo(s) failed — ${failures[0]}`);
  }

  // A Google Drive FOLDER link stands for every photo inside it, so it has to
  // be expanded into ordinary image links before we know how big this import
  // even is. Expansion is the one step needing the Google API key, which is why
  // it happens on the broker. Anything that isn't a folder link passes through.
  //
  // A folder that won't expand is reported and skipped rather than aborting the
  // batch — a drop can carry several links, and one bad one shouldn't cost the
  // others.
  async function expandFolders(urls, notes) {
    const out = [];
    for (const url of urls) {
      if (!isDriveFolderUrl(url)) { out.push(url); continue; }
      try {
        const r = await expandDriveFolder(offerId, url);
        out.push(...r.files.map((f) => f.url));
        if (r.skipped) notes.push(`${r.skipped} item(s) in that folder aren't photos and were left behind`);
        // r.files.length, not our own cap: either end can be the one that
        // truncated, and quoting the wrong number is worse than no number.
        if (r.truncated) notes.push(`that folder holds more than ${r.files.length} photos — only the first ${r.files.length} came in`);
      } catch (e) {
        notes.push(e.message);
      }
    }
    return out;
  }

  // Images dragged in from another browser tab, pasted as links, or named
  // wholesale by a Drive folder link. A cross-origin drag hands over a URL
  // rather than the file, and the browser can't fetch that URL itself (CORS),
  // so the broker pulls the bytes and we resize them through the very same
  // path a picked file takes.
  async function addUrls(urls) {
    const given = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    if (!given.length) return;
    setBusy(true);
    onError("");

    // Reading a folder is a network round trip of its own, and a silent pause
    // before a progress bar appears reads as a hang.
    const notes = [];
    if (given.some(isDriveFolderUrl)) setUploading({ done: 0, total: 0, label: "Reading the Drive folder…" });
    const expanded = [...new Set(await expandFolders(given, notes))];
    const list = expanded.slice(0, MAX_PHOTOS_PER_IMPORT);
    if (expanded.length > list.length) {
      notes.push(`${expanded.length} photos is more than the ${MAX_PHOTOS_PER_IMPORT} this takes at once — the rest were left behind`);
    }

    if (!list.length) {
      setUploading(null);
      setBusy(false);
      onError(notes[0] || "nothing to import from that link");
      return;
    }

    setUploading({ done: 0, total: list.length });
    const failures = [];
    for (const [i, url] of list.entries()) {
      try {
        const dataUrl = await fetchOfferPhotoFromUrl(offerId, url);
        const blob = await (await fetch(dataUrl)).blob();
        await uploadOfferPhoto(offerId, await propertyPhotoVariants(blob));
      } catch (e) {
        failures.push(e.message);
      }
      setUploading({ done: i + 1, total: list.length });
    }
    try { setPhotos(await listOfferPhotos(offerId)); } catch { /* keep what we have */ }
    setUploading(null);
    setBusy(false);
    // One bad link is the common case (an album page, a private photo), so lead
    // with why rather than a count. Folder notes ride along behind it — they
    // explain a smaller-than-expected import, which otherwise looks like a bug.
    if (failures.length) {
      notes.unshift(failures.length === 1 ? failures[0] : `${failures.length} links failed — ${failures[0]}`);
    }
    if (notes.length) onError(notes.join(" · "));
  }

  // A drop can carry real files (from the desktop) or just a URL (from another
  // tab). Prefer files; fall back to whatever URL the browser exposed.
  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const dt = e.dataTransfer;
    if (dt.files?.length) { addFiles(dt.files); return; }
    const uriList = dt.getData("text/uri-list") || "";
    const plain = dt.getData("text/plain") || "";
    const fromHtml = [...(dt.getData("text/html") || "").matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    const urls = [
      ...uriList.split(/\r?\n/).filter((l) => l && !l.startsWith("#")),
      ...fromHtml,
      ...(plain.startsWith("http") ? [plain] : []),
    ];
    if (urls.length) addUrls(urls);
    else onError("That drop didn't carry an image or a link — try dragging the photo itself.");
  }

  const move = (id, delta) => guard(() => {
    const ids = photos.map((p) => p.id);
    const i = ids.indexOf(id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= ids.length) return Promise.resolve(photos);
    ids.splice(to, 0, ids.splice(i, 1)[0]);
    return reorderOfferPhotos(offerId, ids);
  });
  const makeHero = (id) => guard(() =>
    reorderOfferPhotos(offerId, [id, ...photos.map((p) => p.id).filter((x) => x !== id)]));

  return (
    <div className="mb-4 rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={`${LABEL_CLS} mb-0`}>Property photos</span>
        <span className="text-xs text-slate-500">
          {uploading ? (uploading.label || `Uploading ${uploading.done}/${uploading.total}…`)
            : photos?.length ? `${photos.length} photo${photos.length === 1 ? "" : "s"} · first one is the cover`
            : ""}
        </span>
      </div>

      {photos === null ? (
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-slate-400" /></div>
      ) : (
        <>
          {photos.length > 0 && (
            <div className="mb-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p, i) => (
                <div key={p.id} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                  <img src={offerPhotoUrl(offerId, p.id, "thumb")} alt="" loading="lazy"
                    className="block aspect-[3/2] w-full object-cover" />
                  {i === 0 && (
                    <span className="absolute left-1 top-1 rounded bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      COVER
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0.5 bg-slate-900/70 p-1 opacity-0 transition group-hover:opacity-100">
                    <button type="button" disabled={busy || i === 0} title="Move earlier"
                      onClick={() => move(p.id, -1)}
                      className="rounded px-1.5 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-30">←</button>
                    <button type="button" disabled={busy || i === 0} title="Make this the cover"
                      onClick={() => makeHero(p.id)}
                      className="rounded px-1 text-white hover:bg-white/20 disabled:opacity-30"><Star size={12} /></button>
                    <button type="button" disabled={busy || i === photos.length - 1} title="Move later"
                      onClick={() => move(p.id, 1)}
                      className="rounded px-1.5 text-xs font-bold text-white hover:bg-white/20 disabled:opacity-30">→</button>
                    <button type="button" disabled={busy} title="Delete this photo"
                      onClick={() => guard(() => deleteOfferPhoto(offerId, p.id))}
                      className="rounded px-1 text-white hover:bg-red-500/70 disabled:opacity-30"><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} className={BTN_CLS} onClick={() => fileRef.current?.click()}>
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
              {photos.length ? "Add more photos" : "Add photos"}
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <span className="text-xs text-slate-500">or drag one in from another tab</span>
          </div>

          {/* Drop target + link box. Paste works here too: an image on the
              clipboard arrives as a file, a copied address as text. */}
          <div
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onPaste={(e) => {
              if (busy) return;
              const files = [...(e.clipboardData?.files || [])];
              if (files.length) { e.preventDefault(); addFiles(files); return; }
              const text = e.clipboardData?.getData("text") || "";
              if (/^https?:\/\/\S+$/i.test(text.trim())) { e.preventDefault(); addUrls([text]); }
            }}
            className={`mt-2 rounded-lg border border-dashed p-2.5 transition-colors ${
              dragging ? "border-blue-500 bg-blue-50" : "border-slate-300"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                placeholder={dragging ? "Drop it anywhere in this box" : "…or paste an image link, or a Drive folder"}
                value={photoUrl} disabled={busy}
                onChange={(e) => setPhotoUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !photoUrl.trim()) return;
                  e.preventDefault();
                  addUrls([photoUrl]);
                  setPhotoUrl("");
                }}
              />
              <button type="button" disabled={busy || !photoUrl.trim()} className={BTN_CLS}
                onClick={() => { addUrls([photoUrl]); setPhotoUrl(""); }}>
                Fetch
              </button>
            </div>
          </div>

          <p className="mt-2 text-xs text-slate-500">
            Your own photos only — listing photos from Zillow or the MLS are the photographer's copyright,
            not yours to republish. Resized in your browser before upload. A link has to point at the image
            itself, not at an album page — in Google Photos, open the photo, right-click it and copy the
            image address.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            A Google Drive folder link brings in everything inside it, named order first. The folder has to
            be shared "Anyone with the link", and Settings needs a Google API key.
          </p>
        </>
      )}
    </div>
  );
}

export default function DataroomModal({ offer, deals = [], onSwitch, onBackToDeals, onClose }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [room, setRoom] = useState(null);       // full room incl. snapshot + invites
  const [events, setEvents] = useState([]);
  const [fresh, setFresh] = useState([]);       // just-minted links, newest first
  const [draft, setDraft] = useState({ headline: "", notes: "", expiryDays: 14, sections: null });
  const [liveSend, setLiveSend] = useState(false);
  const [roomsByOffer, setRoomsByOffer] = useState({}); // offerId -> summary, for the deal strip
  const [portfolio, setPortfolio] = useState(null);     // { shareLink, listedCount, views }

  const dealInvestors = offer.deal?.investors || [];

  // Load the newest room for this offer, if one exists. Re-runs when the
  // operator switches deals from the strip, so every switch starts clean.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRoom(null);
    setEvents([]);
    setFresh([]);
    setError("");
    (async () => {
      try {
        const rooms = await listDatarooms(offer.id);
        if (cancelled) return;
        if (rooms.length) {
          const full = await getDataroom(rooms[0].id);
          if (cancelled) return;
          setRoom(full.dataroom);
          setEvents(full.events || []);
        }
      } catch (e) { if (!cancelled) setError(e.message); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [offer.id]);

  // Every dataroom in the location, so the strip can show which other deals
  // have packages out and where investors are actually looking.
  const refreshStrip = async () => {
    try {
      const all = await listDatarooms();
      setRoomsByOffer(Object.fromEntries(all.map((r) => [r.offerId, r])));
    } catch { /* the strip is a convenience — never block the screen on it */ }
    try {
      setPortfolio(await getDataroomPortfolio());
    } catch { /* likewise the portfolio summary */ }
  };
  useEffect(() => { refreshStrip(); }, [offer.id]);

  const run = async (fn) => {
    setError(""); setBusy(true);
    try { return await fn(); }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  };

  const reload = async () => {
    const full = await getDataroom(room.id);
    setRoom(full.dataroom);
    setEvents(full.events || []);
    refreshStrip();
  };

  async function build() {
    await run(async () => {
      const created = await createDataroom({
        offerId: offer.id,
        headline: draft.headline,
        notes: draft.notes,
        expiryDays: draft.expiryDays,
      });
      const full = await getDataroom(created.id);
      setRoom(full.dataroom);
      setEvents(full.events || []);
      refreshStrip();
    });
  }

  const sections = room?.snapshot?.sections || {};

  async function toggleSection(key) {
    await run(async () => {
      const next = { ...sections, [key]: !sections[key] };
      setRoom((r) => ({ ...r, snapshot: { ...r.snapshot, sections: next } }));
      await updateDataroom(room.id, { sections: next });
    });
  }

  // What the tokenless public teaser (the website's deal page) may show.
  // Server-normalized: documents and the price breakdown can never go public.
  const publicSections = room?.publicSections || {};

  async function togglePublicSection(key) {
    await run(async () => {
      const next = { ...publicSections, [key]: !publicSections[key] };
      setRoom((r) => ({ ...r, publicSections: next }));
      await updateDataroom(room.id, { publicSections: next });
    });
  }

  async function saveText(patch) {
    await run(async () => {
      const saved = await updateDataroom(room.id, patch);
      setRoom((r) => ({ ...saved, invites: r.invites }));
    });
  }

  /* ---- external links shown to investors ---- */
  // A tour, a Drive folder of inspection reports, a county parcel page. Stored
  // on the room (not the offer), so "Refresh from the offer" leaves them alone.
  const links = Array.isArray(room?.snapshot?.links) ? room.snapshot.links : [];
  const [linkDraft, setLinkDraft] = useState({ label: "", url: "" });

  async function addLink() {
    const url = linkDraft.url.trim();
    if (!url) return;
    // Prepend https:// when the operator pastes a bare host — the server only
    // accepts http/https and would otherwise reject "matterport.com/foo".
    const href = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
    try {
      const u = new URL(href);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad scheme");
    } catch {
      setError("That doesn't look like a web address — links must start with http:// or https://");
      return;
    }
    await saveText({ links: [...links, { label: linkDraft.label.trim(), url: href }] });
    setLinkDraft({ label: "", url: "" });
  }
  const removeLink = (id) => saveText({ links: links.filter((l) => l.id !== id) });

  async function invite(contact) {
    await run(async () => {
      const r = await createDataroomInvite(room.id, {
        contactId: contact.id, name: contact.name, phone: contact.phone,
        send: Boolean(contact.phone), dryRun: !liveSend,
      });
      setFresh((f) => [{
        inviteId: r.invite.id, link: r.link,
        name: r.invite.name, phone: r.invite.phone, sendResult: r.send,
      }, ...f]);
      await reload();
    });
  }

  async function sendFresh(item) {
    await run(async () => {
      const r = await sendDataroomInvite(room.id, item.inviteId, {
        token: item.link.split("/d/")[1], dryRun: !liveSend,
      });
      setFresh((f) => f.map((x) => (x.inviteId === item.inviteId ? { ...x, sendResult: r.send } : x)));
      await reload();
    });
  }

  async function reissue(inv) {
    await run(async () => {
      const r = await reissueDataroomInvite(room.id, inv.id, { send: Boolean(inv.phone), dryRun: !liveSend });
      setFresh((f) => [{
        inviteId: inv.id, link: r.link,
        name: r.invite.name, phone: r.invite.phone, sendResult: r.send,
      }, ...f.filter((x) => x.inviteId !== inv.id)]);
      await reload();
    });
  }

  const invites = room?.invites || [];
  const existingIds = new Set(invites.filter((i) => i.status === "active").map((i) => i.contactId));
  const n = room?.snapshot?.numbers || {};

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-bold">
              <Lock size={17} className="text-slate-400" /> Investor dataroom
            </div>
            <div className="text-sm text-slate-500">
              {offer.address || "Deal"}
              {room && n.investorPrice > 0 ? ` · ${fmtMoney(n.investorPrice)} to the investor` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onBackToDeals && (
              <button type="button" onClick={onBackToDeals} className={BTN_CLS} title="Close and go back to the deals board">
                <ArrowLeft size={13} /> All deals
              </button>
            )}
            <button type="button" onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-slate-100">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Every active deal, with where its investors are looking — switching
            here keeps the operator inside the dataroom instead of bouncing out. */}
        {deals.length > 1 && (
          <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
            {deals.map((d) => {
              const s = roomsByOffer[d.id];
              const current = d.id === offer.id;
              return (
                <button key={d.id} type="button" disabled={busy || current}
                  onClick={() => onSwitch?.(d)}
                  title={d.address || "Deal"}
                  className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-left text-xs disabled:cursor-default ${
                    current ? "border-blue-600 bg-blue-50" : "border-slate-200 hover:bg-slate-50"
                  }`}>
                  <span className={`block max-w-[170px] truncate font-semibold ${current ? "text-blue-800" : ""}`}>
                    {shortAddress(d.address)}
                  </span>
                  <span className={`block text-[11px] ${!s && !current ? "font-semibold text-blue-700" : "text-slate-500"}`}>
                    {!s ? (current ? "no package yet" : "tap to build a link")
                      : s.status === "revoked" ? "switched off"
                      : s.viewCount > 0 ? `${s.viewCount} view${s.viewCount === 1 ? "" : "s"}`
                      : "not opened yet"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : !room ? (
          /* ---------- build the package ---------- */
          <div>
            <p className="mb-4 text-sm text-slate-600">
              Build a web page from this deal — the numbers, the comps, the scope, and the PDFs — and get one
              link to send your whole buyer list. It's unlisted and unguessable, you can see how many times
              it's been opened, and you can kill it any time.
            </p>
            <div className="mb-3">
              <span className={LABEL_CLS}>Headline (optional)</span>
              <input className={INPUT_CLS} value={draft.headline} maxLength={120}
                onChange={(e) => setDraft((d) => ({ ...d, headline: e.target.value }))}
                placeholder="4/2.5 in Sumner — assignable, inspection done" />
            </div>
            <div className="mb-3">
              <span className={LABEL_CLS}>Deal notes for investors (optional)</span>
              <textarea rows={3} className={INPUT_CLS} value={draft.notes} maxLength={2000}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                placeholder="Seller is relocating and wants a fast close. Vacant at closing." />
            </div>
            <div className="mb-4 max-w-xs">
              <span className={LABEL_CLS}>Tracked investor links expire after</span>
              <select className={INPUT_CLS} value={draft.expiryDays}
                onChange={(e) => setDraft((d) => ({ ...d, expiryDays: Number(e.target.value) }))}>
                {[3, 7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-500">
                The shared deal link doesn't expire — rotate it when you want it dead.
              </p>
            </div>
            <button type="button" onClick={build} disabled={busy}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />} Build the dataroom
            </button>
          </div>
        ) : (
          /* ---------- manage ---------- */
          <div>
            {room.status === "revoked" && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <span>Every link to this dataroom is switched off.</span>
                <button type="button" disabled={busy} className={BTN_CLS}
                  onClick={() => run(async () => { await revokeDataroom(room.id, false); await reload(); })}>
                  Turn back on
                </button>
              </div>
            )}

            {/* --- one link for every deal at once --- */}
            {portfolio?.shareLink && (
              <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50/50 p-3">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className={`${LABEL_CLS} mb-0 text-blue-800`}>All deals — one link for your buyer list</span>
                  <span className="text-xs text-blue-800">
                    {portfolio.listedCount} listed{portfolio.views > 0 ? ` · ${portfolio.views} views` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input readOnly value={portfolio.shareLink} onFocus={(e) => e.target.select()}
                    className="w-full rounded-lg border border-blue-200 bg-white px-2.5 py-2 font-mono text-xs" />
                  <CopyButton value={portfolio.shareLink} className={`${BTN_CLS} shrink-0 border-blue-300 bg-white`} />
                  <a href={portfolio.shareLink} target="_blank" rel="noreferrer"
                    className={`${BTN_CLS} shrink-0 border-blue-300 bg-white`}>
                    <Eye size={13} /> View
                  </a>
                </div>
                <p className="mt-2 text-xs text-blue-800">
                  Every listed deal on one page, each linking to its full package. It updates itself as you
                  add or remove deals — send this once and it stays current.
                </p>
              </div>
            )}

            {/* --- this deal's own link --- */}
            <div className="mb-4 rounded-xl border border-slate-200 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className={`${LABEL_CLS} mb-0`}>Deal link — send this to your buyers</span>
                <span className="text-xs text-slate-500">
                  {room.shareViews > 0
                    ? `${room.shareViews} view${room.shareViews === 1 ? "" : "s"}${
                        room.shareLastViewedAt ? ` · last ${shortDateTime(room.shareLastViewedAt)}` : ""}`
                    : "not opened yet"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input readOnly value={room.shareLink || ""}
                  onFocus={(e) => e.target.select()}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-2 font-mono text-xs" />
                <CopyButton value={room.shareLink || ""} className={`${BTN_CLS} shrink-0 bg-white`} />
                <a href={room.shareLink || "#"} target="_blank" rel="noreferrer"
                  className={`${BTN_CLS} shrink-0 bg-white`} title="Open it the way a buyer will see it">
                  <Eye size={13} /> View
                </a>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy} className="text-xs font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-50"
                  onClick={() => run(async () => { await rotateDataroomShareLink(room.id); await reload(); })}
                  title="Kill this URL and generate a new one">
                  Rotate link
                </button>
                <span className="text-xs text-slate-500">
                  Anyone with this link can open the package — share it freely, rotate it to kill it.
                </span>
              </div>
              <label className="mt-2 flex items-start gap-2 border-t border-slate-100 pt-2 text-xs">
                <input type="checkbox" checked={!room.unlisted} disabled={busy} className="mt-0.5 h-3.5 w-3.5"
                  onChange={(e) => run(async () => {
                    await updateDataroom(room.id, { unlisted: !e.target.checked });
                    await reload();
                  })} />
                <span>
                  Show this deal on the all-deals page
                  <span className="block text-slate-500">
                    Untick to keep it off the public list — its own link above keeps working either way.
                  </span>
                </span>
              </label>
            </div>

            {/* --- the public teaser: what the website shows --- */}
            <div className="mb-4 rounded-xl border border-slate-200 p-3">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className={`${LABEL_CLS} mb-0`}>Public teaser — what the website shows</span>
              </div>
              <div className="flex items-center gap-2">
                <input readOnly value={room.teaserLink || ""}
                  onFocus={(e) => e.target.select()}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-2 font-mono text-xs" />
                <CopyButton value={room.teaserLink || ""} className={`${BTN_CLS} shrink-0 bg-white`} />
                <a href={room.teaserLink || "#"} target="_blank" rel="noreferrer"
                  className={`${BTN_CLS} shrink-0 bg-white`} title="Open it the way a website visitor will see it">
                  <Eye size={13} /> View
                </a>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                The tokenless page your site's deal cards open. It can only ever show a subset of the
                package above; documents and the price breakdown never go public. Live while the deal
                is on the all-deals page.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-slate-100 pt-2 sm:grid-cols-3">
                {PUBLIC_SECTIONS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={Boolean(publicSections[key])} disabled={busy}
                      className="h-3.5 w-3.5" onChange={() => togglePublicSection(key)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>

            <PhotosPane offerId={offer.id} busy={busy} setBusy={setBusy} onError={setError} />
            <VideosPane offerId={offer.id} busy={busy} setBusy={setBusy} onError={setError} />

            {fresh.map((item) => (
              <FreshLink key={item.inviteId + item.link} item={item} busy={busy}
                onSend={() => sendFresh(item)}
                onDismiss={() => setFresh((f) => f.filter((x) => x.inviteId !== item.inviteId))} />
            ))}

            {/* --- optional per-investor links, for attribution --- */}
            <div className="mb-2 flex items-center justify-between">
              <span className={`${LABEL_CLS} mb-0`}>Tracked links (optional)</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <input type="checkbox" checked={liveSend} className="h-3.5 w-3.5"
                  onChange={(e) => setLiveSend(e.target.checked)} />
                Actually send texts
              </label>
            </div>

            {invites.length === 0 ? (
              <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-500">
                Want to know exactly who's looking? Give a specific buyer their own link below — it's
                watermarked with their name and tracked separately from the deal link.
              </p>
            ) : (
              <div className="mb-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {invites.map((i) => {
                  const dead = i.status === "revoked" || i.expired;
                  return (
                    <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className={dead ? "text-slate-400 line-through" : ""}>{i.name || i.contactId}</span>
                          {i.status === "revoked" && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">revoked</span>}
                          {i.expired && i.status !== "revoked" && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">expired</span>}
                        </div>
                        <div className="text-xs text-slate-500">
                          {i.viewCount > 0
                            ? <span className="font-medium text-emerald-700">
                                <Eye size={11} className="mr-1 inline" />
                                opened {i.viewCount}× · last {shortDateTime(i.lastViewedAt)}
                              </span>
                            : i.sentAt ? `texted ${shortDateTime(i.sentAt)} · not opened yet` : "not sent yet"}
                          {i.expiresAt && !i.expired ? ` · expires ${shortDate(i.expiresAt)}` : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <button type="button" disabled={busy} className={BTN_CLS} onClick={() => reissue(i)}
                          title="Issue a fresh link — the old one stops working immediately">
                          <RefreshCw size={12} /> Reissue
                        </button>
                        <button type="button" disabled={busy} className={`${BTN_CLS} ${i.status === "revoked" ? "" : "text-red-700"}`}
                          onClick={() => run(async () => { await revokeDataroomInvite(room.id, i.id, i.status !== "revoked"); await reload(); })}
                          title={i.status === "revoked" ? "Restore this link" : "Kill this link now"}>
                          <ShieldOff size={12} /> {i.status === "revoked" ? "Restore" : "Revoke"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {room.status !== "revoked" && (
              <div className="mb-1">
                <ContactPicker existingIds={existingIds} busy={busy} onPick={invite} />
              </div>
            )}
            {dealInvestors.length > 0 && room.status !== "revoked" && (
              <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <span>On this deal:</span>
                {dealInvestors.filter((d) => !existingIds.has(d.contactId)).map((d) => (
                  <button key={d.contactId} type="button" disabled={busy}
                    className="rounded-full border border-slate-300 px-2 py-0.5 font-medium hover:bg-slate-50 disabled:opacity-50"
                    onClick={() => invite({ id: d.contactId, name: d.name })}>
                    + {d.name}
                  </button>
                ))}
              </div>
            )}
            {!liveSend && (
              <p className="mb-4 text-xs text-slate-500">
                Texts are in test mode — you'll see the message without sending it. Tick “Actually send texts” to go live.
              </p>
            )}

            {/* --- what's in the package --- */}
            <div className="mb-4 rounded-xl border border-slate-200 p-3">
              <span className={LABEL_CLS}>What investors see</span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {SECTIONS.map(([key, label, hint]) => (
                  <label key={key} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(sections[key])} disabled={busy} className="mt-0.5 h-4 w-4"
                      onChange={() => toggleSection(key)} />
                    <span>
                      <span className={key === "feeBreakdown" && sections[key] ? "font-semibold text-amber-700" : ""}>{label}</span>
                      <span className="block text-xs text-slate-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {sections.feeBreakdown && (
                <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  Investors will see your contract price and assignment fee.
                </p>
              )}
              <HeadlineNumbers room={room} busy={busy} onSave={saveText} />
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <span className={LABEL_CLS}>Headline</span>
                  <input className={INPUT_CLS} defaultValue={room.snapshot?.headline || ""} maxLength={120}
                    onBlur={(e) => e.target.value !== (room.snapshot?.headline || "") && saveText({ headline: e.target.value })} />
                </div>
                <div>
                  <span className={LABEL_CLS}>Deal notes</span>
                  <textarea rows={2} className={INPUT_CLS} defaultValue={room.snapshot?.notes || ""} maxLength={2000}
                    onBlur={(e) => e.target.value !== (room.snapshot?.notes || "") && saveText({ notes: e.target.value })} />
                </div>
              </div>
              <div className="mt-3">
                <span className={LABEL_CLS}>Links for investors</span>
                <p className="mb-2 text-xs text-slate-500">
                  Anything that lives elsewhere — a 3D tour, a Drive folder of inspection reports, the county
                  parcel page. They show up next to the PDFs in the investor's Documents card.
                </p>
                {links.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {links.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium">{l.label}</span>
                        <a href={l.url} target="_blank" rel="noreferrer"
                          className="min-w-0 max-w-[45%] truncate text-xs text-blue-700 hover:underline" title={l.url}>
                          {l.host || l.url}
                        </a>
                        <button type="button" disabled={busy} onClick={() => removeLink(l.id)}
                          className="shrink-0 rounded p-0.5 text-slate-400 hover:text-red-600" title="Remove this link">
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <input className={`${INPUT_CLS} w-40 flex-none`} placeholder="Label" maxLength={80}
                    value={linkDraft.label} onChange={(e) => setLinkDraft((d) => ({ ...d, label: e.target.value }))} />
                  <input className={`${INPUT_CLS} min-w-0 flex-1`} placeholder="https://…" maxLength={600}
                    value={linkDraft.url} onChange={(e) => setLinkDraft((d) => ({ ...d, url: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} />
                  <button type="button" onClick={addLink} disabled={busy || !linkDraft.url.trim() || links.length >= 12}
                    className={BTN_CLS} title={links.length >= 12 ? "12 links is the limit" : "Add this link"}>
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={busy} className={BTN_CLS}
                  onClick={() => run(async () => { await updateDataroom(room.id, { refresh: true }); await reload(); })}
                  title="Re-read the offer so everyone holding a live link sees the current numbers">
                  <RefreshCw size={12} /> Refresh from the offer
                </button>
                <span className="text-xs text-slate-500">
                  Built {shortDateTime(room.snapshot?.builtAt)} — price, ARV and rehab follow the offer on their own
                  unless you've set them above; comps, scope and photos don't reach investors until you refresh.
                </span>
              </div>
            </div>

            {/* --- access log --- */}
            {events.length > 0 && (
              <details className="mb-4">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Access log ({events.length})
                </summary>
                <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-slate-200 text-xs">
                  {events.map((e) => (
                    <div key={e.id} className="flex justify-between gap-3 border-b border-slate-100 px-2.5 py-1.5 last:border-0">
                      <span>
                        <span className="font-semibold">{e.kind}</span>
                        {e.detail?.name ? ` · ${e.detail.name}` : ""}
                        {e.detail?.kind ? ` · ${e.detail.kind}` : ""}
                      </span>
                      <span className="shrink-0 text-slate-500">{shortDateTime(e.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {room.status !== "revoked" && (
              <button type="button" disabled={busy}
                className="flex items-center gap-1.5 text-xs font-semibold text-red-700 hover:underline disabled:opacity-50"
                onClick={() => run(async () => { await revokeDataroom(room.id, true); await reload(); })}>
                <Trash2 size={12} /> Switch off every link to this dataroom
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
