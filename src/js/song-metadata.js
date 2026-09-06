import * as backend from "./backend.js";
import { focusModal } from "./modal-focus.js";
import { setArtwork } from "./artwork.js";
import "./song-metadata.css";

export const songFields = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["albumArtist", "Album artist"],
  ["year", "Release year"],
  ["genre", "Genre"],
  ["trackNumber", "Track number"],
  ["discNumber", "Disc number"],
  ["musicalKey", "Musical key"],
  ["tuning", "Tuning"],
  ["tags", "Personal tags"],
  ["notes", "Notes"],
];
const friendlyError = (error) =>
  typeof error?.data === "string"
    ? error.data
    : error?.message?.includes("[CONVEX")
      ? "Could not complete this request. Please try again."
      : error?.message || "Something went wrong. Please try again.";
const durationLabel = (seconds) =>
  seconds > 0
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const artistLabel = (song) =>
  song.artist ||
  (song.metadataLocks?.includes("artist") ? "" : song.uploader || "");
export function commonValue(songs, key) {
  const values = songs.map((s) =>
    key === "tags" ? (s.tags ?? []).join(", ") : (s[key] ?? ""),
  );
  return values.every((v) => v === values[0]) ? values[0] : null;
}
export function draftPatch(form, touched) {
  return Object.fromEntries(
    [...touched]
      .filter((k) => k !== "artwork")
      .map((key) => {
        const value = form.elements.namedItem(key).value.trim();
        return [
          key,
          key === "tags"
            ? [
                ...new Set(
                  value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                ),
              ]
            : value,
        ];
      }),
  );
}

export function editSongs(songs, api = backend) {
  if (!songs.length || document.querySelector(".metadata-modal")) return;
  const bulk = songs.length > 1,
    song = songs[0],
    touched = new Set();
  let artwork,
    imageFile,
    imagePreview,
    busy = false,
    lookupGeneration = 0;
  const modal = document.createElement("div");
  modal.className = "modal metadata-modal";
  const field = ([key, label]) => {
    const value = commonValue(songs, key),
      mixed = value === null;
    const number = ["year", "trackNumber", "discNumber"].includes(key);
    return `<label class="field metadata-field ${key === "notes" || key === "tags" ? "wide" : ""}" data-field="${key}" for="metadata-${key}"><span>${label}${bulk ? ` <input type="checkbox" data-apply="${key}" aria-label="Apply ${label.toLowerCase()} to selected songs">` : ""}</span>
      ${key === "notes" ? `<textarea id="metadata-${key}" name="${key}" rows="4" maxlength="10000" placeholder="${mixed ? "Multiple values — unchanged" : "What are you working on?"}">${esc(value)}</textarea>` : `<input id="metadata-${key}" name="${key}" type="text" ${number ? 'inputmode="numeric"' : ""} maxlength="${key === "tags" ? 1800 : 500}" ${key === "title" && !bulk ? "required" : ""} ${key === "year" ? 'pattern="[0-9]{4}"' : ""} ${["trackNumber", "discNumber"].includes(key) ? 'pattern="[1-9][0-9]{0,3}"' : ""} value="${esc(value)}" placeholder="${mixed ? "Multiple values — unchanged" : key === "tags" ? "e.g. warmup, audition" : key === "tuning" ? "e.g. Standard, Drop D" : ""}">`}</label>`;
  };
  modal.innerHTML = `<form class="modal-card metadata-editor"><header class="metadata-heading"><div><h2>${bulk ? `Edit ${songs.length} songs` : "Edit song"}</h2></div><button type="button" class="btn-ghost" data-close aria-label="Close editor">✕</button></header>
    <div class="metadata-body">${bulk ? '<p class="hint">Only checked fields will change. Editing a field checks it automatically. Empty checked fields will be cleared.</p>' : `<div class="metadata-art-row"><div class="metadata-art"></div><div class="metadata-art-actions"><button type="button" class="btn-ghost" data-cover>Choose another cover</button><button type="button" class="btn-ghost" data-upload>Upload image</button><button type="button" class="btn-ghost" data-remove>Remove artwork</button><input type="file" accept="image/jpeg,image/png,image/webp" hidden data-file><p class="hint">JPEG, PNG or WebP · up to 2 MB</p></div></div><div class="metadata-lookup"><span data-lookup-status>${song.metadataStatus === "pending" ? "Finding song details…" : ""}</span><button type="button" class="btn-ghost" data-find>Find another match</button></div><section data-matches hidden aria-label="Find metadata"></section>`}
    <h3>Song details</h3><div class="metadata-fields">${songFields.slice(0, 8).map(field).join("")}</div>
    <h3>Practice</h3><div class="metadata-fields">${songFields.slice(8).map(field).join("")}</div></div>
    <footer class="metadata-footer"><p role="status" class="metadata-message"></p><button type="button" class="btn-ghost" data-cancel>Cancel</button><button type="submit" class="btn-primary" data-save disabled>${bulk ? "Save changes" : "Save"}</button></footer></form>`;
  document.body.append(modal);
  const form = modal.querySelector("form"),
    message = modal.querySelector(".metadata-message"),
    save = modal.querySelector("[data-save]");
  const sync = () => {
    save.disabled = busy || !touched.size;
    modal
      .querySelectorAll("[data-field]")
      .forEach((el) =>
        el.classList.toggle("is-edited", touched.has(el.dataset.field)),
      );
  };
  const close = () => {
    if (busy) return;
    if (touched.size && !window.confirm("Discard your unsaved changes?"))
      return;
    lookupGeneration++;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    modal.remove();
  };
  focusModal(modal, close);
  modal.querySelector("[data-close]").onclick = close;
  modal.querySelector("[data-cancel]").onclick = close;
  // Outside clicks intentionally keep the draft open.
  form.addEventListener("input", (e) => {
    if (!songFields.some(([k]) => k === e.target.name)) return;
    touched.add(e.target.name);
    const check = form.querySelector(`[data-apply="${e.target.name}"]`);
    if (check) check.checked = true;
    sync();
  });
  form.querySelectorAll("[data-apply]").forEach(
    (check) =>
      (check.onchange = () => {
        if (check.checked) touched.add(check.dataset.apply);
        else touched.delete(check.dataset.apply);
        sync();
      }),
  );
  const preview = (url) => {
    if (!bulk)
      setArtwork(
        modal.querySelector(".metadata-art"),
        { ...song, ...draftPatch(form, touched) },
        url,
      );
  };
  if (!bulk) {
    preview(song.coverUrl);
    if (song.coverKey)
      api
        .signKey(song.coverKey)
        .then((url) => {
          if (modal.isConnected && !touched.has("artwork")) preview(url);
        })
        .catch(() => {});
    modal.querySelector("[data-upload]").onclick = () =>
      modal.querySelector("[data-file]").click();
    modal.querySelector("[data-file]").onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (
        file.size > 2000000 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      ) {
        message.textContent = "Choose a JPEG, PNG or WebP image under 2 MB.";
        return;
      }
      try {
        const bitmap = await createImageBitmap(file);
        bitmap.close();
      } catch {
        message.textContent =
          "This image could not be read. Choose another file.";
        return;
      }
      if (!modal.isConnected) return;
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      imagePreview = URL.createObjectURL(file);
      imageFile = file;
      artwork = undefined;
      touched.add("artwork");
      preview(imagePreview);
      message.textContent = "Artwork ready to save.";
      sync();
    };
    modal.querySelector("[data-remove]").onclick = () => {
      imageFile = undefined;
      artwork = { kind: "removed" };
      touched.add("artwork");
      preview(null);
      sync();
    };
    modal.querySelector("[data-find]").onclick = () => openLookup(false);
    modal.querySelector("[data-cover]").onclick = () => openLookup(true);
  }
  async function openLookup(coverOnly) {
    const panel = modal.querySelector("[data-matches]");
    panel.hidden = false;
    const generation = ++lookupGeneration;
    panel.innerHTML = `<div class="metadata-search"><label class="field"><span>Title</span><input data-search-title value="${esc(form.elements.title.value)}"></label><label class="field"><span>Artist</span><input data-search-artist value="${esc(form.elements.artist.value)}"></label><button type="button" class="btn-ghost" data-search>Search</button><button type="button" class="btn-ghost" data-hide>Close search</button></div><p class="metadata-attribution">Metadata: <a href="https://musicbrainz.org" target="_blank" rel="noopener noreferrer">MusicBrainz</a>; artwork from Cover Art Archive.</p><div data-results aria-live="polite"></div>`;
    const results = panel.querySelector("[data-results]");
    panel.querySelector("[data-hide]").onclick = () => {
      lookupGeneration++;
      panel.hidden = true;
    };
    const active = () => modal.isConnected && generation === lookupGeneration;
    let requestNumber = 0;
    async function run(recordingId) {
      const request = ++requestNumber;
      const latest = () => active() && request === requestNumber;
      const previousResults = [...results.childNodes];
      results.textContent = "Finding matches…";
      panel.querySelector("[data-search]").disabled = true;
      try {
        const candidates = await api.findMetadata(
          song.id,
          panel.querySelector("[data-search-title]").value,
          panel.querySelector("[data-search-artist]").value,
          recordingId,
        );
        if (!latest()) return;
        results.replaceChildren();
        if (!candidates.length)
          results.textContent =
            "No matches found. Try a different title or artist, or edit the fields below.";
        candidates.forEach((c) => {
          const row = document.createElement("div");
          row.className = "metadata-match";
          row.innerHTML = `${c.releaseId ? `<img src="https://coverartarchive.org/release/${esc(c.releaseId)}/front-250" alt="" loading="lazy">` : ""}<div><strong>${esc(recordingId ? c.album : c.title)}</strong><p>${esc([c.artist, c.album, c.year, durationLabel(c.duration), c.disambiguation].filter(Boolean).join(" · "))}</p></div><button type="button" class="btn-ghost" data-review>${coverOnly && c.releaseId ? "Use cover" : "Review"}</button>${!recordingId ? '<button type="button" class="btn-ghost" data-releases>Albums / covers</button>' : ""}`;
          row
            .querySelector("img")
            ?.addEventListener("error", (e) => e.target.remove());
          row
            .querySelector("[data-releases]")
            ?.addEventListener("click", () => run(c.recordingId));
          row.querySelector("[data-review]").onclick = async () => {
            if (coverOnly) {
              if (!c.releaseId) {
                await run(c.recordingId);
                return;
              }
              artwork = { kind: "release", releaseId: c.releaseId };
              imageFile = undefined;
              touched.add("artwork");
              preview(
                `https://coverartarchive.org/release/${c.releaseId}/front-500`,
              );
              message.textContent = "Cover selected. Save to keep it.";
              sync();
              return;
            }
            try {
              row.querySelector("[data-review]").disabled = true;
              const detail = await api.metadataDetail(
                song.id,
                c.recordingId,
                c.releaseId,
              );
              if (active()) review(detail);
            } catch (e) {
              message.textContent = friendlyError(e);
            } finally {
              if (row.isConnected)
                row.querySelector("[data-review]").disabled = false;
            }
          };
          results.append(row);
        });
      } catch (e) {
        if (latest()) {
          results.replaceChildren(...previousResults);
          const error = document.createElement("p");
          error.textContent = friendlyError(e);
          results.prepend(error);
        }
      } finally {
        if (latest()) panel.querySelector("[data-search]").disabled = false;
      }
    }
    function review(c) {
      results.replaceChildren();
      const heading = document.createElement("p");
      heading.textContent = "Review changes";
      results.append(heading);
      const fields = songFields.filter(
        ([key]) =>
          typeof c[key] === "string" &&
          c[key] &&
          c[key] !== form.elements[key].value,
      );
      for (const [key, label] of fields) {
        const row = document.createElement("label");
        row.className = "metadata-review";
        row.innerHTML = `<input type="checkbox" data-proposed="${key}" ${song.metadataLocks?.includes(key) || touched.has(key) ? "" : "checked"}><span><strong>${label}</strong><small>${esc(form.elements[key].value || "Empty")} → ${esc(c[key])}</small></span>`;
        results.append(row);
      }
      if (!fields.length) {
        const p = document.createElement("p");
        p.textContent = "These details already match your draft.";
        results.append(p);
      }
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "btn-primary";
      apply.textContent = "Use selected details";
      apply.onclick = () => {
        results.querySelectorAll("[data-proposed]:checked").forEach((check) => {
          const key = check.dataset.proposed;
          form.elements[key].value = c[key];
          touched.add(key);
        });
        sync();
        panel.hidden = true;
        message.textContent = "Details added to your draft.";
      };
      results.append(apply);
    }
    panel.querySelector("[data-search]").onclick = () => run();
    panel.querySelectorAll("input").forEach((input) =>
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          run();
        }
      }),
    );
    await run();
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy || !touched.size) return;
    const changes = draftPatch(form, touched);
    if (changes.title !== undefined && !changes.title) {
      message.textContent = "Enter a song title.";
      form.elements.title.focus();
      return;
    }
    busy = true;
    lookupGeneration++;
    form
      .querySelectorAll("input,textarea,button")
      .forEach((el) => (el.disabled = true));
    message.textContent = "Saving…";
    try {
      if (touched.has("artwork")) {
        if (imageFile) {
          artwork = {
            kind: "upload",
            key: await api.uploadArtwork(song.id, imageFile),
          };
          imageFile = undefined;
        }
        changes.artwork = artwork;
      }
      await api.updateMetadata(
        songs.map((s) => s.id),
        changes,
      );
      if (imagePreview) URL.revokeObjectURL(imagePreview);
      modal.remove();
    } catch (error) {
      message.textContent = friendlyError(error);
      busy = false;
      form
        .querySelectorAll("input,textarea,button")
        .forEach((el) => (el.disabled = false));
      sync();
    }
  };
}
