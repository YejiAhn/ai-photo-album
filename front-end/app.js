(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var settingsPanel = $("settings-panel");
  var settingsToggle = $("settings-toggle");
  var fileInput = $("photo-file");
  var selectedFile = null;
  var previewUrl = null;
  var storageKey = "frame-api-key";
  var apiKey = (window.PHOTO_ALBUM_CONFIG || {}).apiKey || "";
  try { apiKey = sessionStorage.getItem(storageKey) || apiKey; } catch (_) {}
  $("api-key").value = apiKey;

  function status(id, message, kind) {
    var element = $(id);
    element.textContent = message;
    element.classList.remove("error", "success");
    if (kind) element.classList.add(kind);
  }

  function showSettings() {
    settingsPanel.hidden = false;
    settingsToggle.setAttribute("aria-expanded", "true");
    $("api-key").focus();
  }

  function client() {
    if (!window.apigClientFactory || !window.apiGateway) throw new Error("SDK files are missing. Check the sdk folder and reload.");
    if (!apiKey.trim()) {
      showSettings();
      throw new Error("Open Settings and save your API key first.");
    }
    return window.apigClientFactory.newClient({ apiKey: apiKey.trim() });
  }

  function errorMessage(error) {
    var response = error && error.response;
    if (response) {
      if (response.status === 403) return "Access denied. Check the API key in Settings.";
      if (response.status === 429) return "Too many requests. Wait a moment and try again.";
      var body = response.data;
      if (body && typeof body === "object" && typeof body.message === "string") return body.message;
      return "Request failed (HTTP " + response.status + "). Please try again.";
    }
    if (error instanceof TypeError || (error && /network|failed to fetch/i.test(error.message))) return "Could not reach the album. Check your connection and API CORS settings.";
    return error && error.message ? error.message : "Something went wrong. Please try again.";
  }

  settingsToggle.addEventListener("click", function () {
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsToggle.setAttribute("aria-expanded", String(!settingsPanel.hidden));
  });
  $("settings-form").addEventListener("submit", function (event) {
    event.preventDefault();
    apiKey = $("api-key").value.trim();
    if (!apiKey) { status("settings-status", "Enter an API key to continue.", "error"); return; }
    try { sessionStorage.setItem(storageKey, apiKey); } catch (_) {}
    status("settings-status", "API key saved. You can upload and search now.", "success");
  });

  function chooseFile(file) {
    selectedFile = null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    $("file-preview").hidden = true;
    $("file-preview").removeAttribute("src");
    $("change-photo").hidden = true;
    $("file-empty").hidden = false;
    $("file-name").textContent = "No photo selected";
    status("upload-status", "");
    if (!file) return;
    if (!/\.(png|jpe?g)$/i.test(file.name) || (file.type && !["image/png", "image/jpeg"].includes(file.type))) {
      status("upload-status", "Choose a JPG or PNG photo.", "error"); return;
    }
    if (!file.size || file.size > 5 * 1024 * 1024) {
      status("upload-status", "Choose a photo between 1 byte and 5 MB.", "error"); return;
    }
    selectedFile = file;
    previewUrl = URL.createObjectURL(file);
    $("file-preview").src = previewUrl;
    $("file-preview").hidden = false;
    $("change-photo").hidden = false;
    $("file-empty").hidden = true;
    $("file-name").textContent = file.name + " · " + (file.size / 1024).toFixed(0) + " KB";
  }

  fileInput.addEventListener("change", function () { chooseFile(fileInput.files[0]); });
  var dropzone = $("dropzone");
  ["dragenter", "dragover"].forEach(function (name) {
    dropzone.addEventListener(name, function (event) { event.preventDefault(); dropzone.classList.add("dragging"); });
  });
  ["dragleave", "drop"].forEach(function (name) {
    dropzone.addEventListener(name, function (event) { event.preventDefault(); dropzone.classList.remove("dragging"); });
  });
  dropzone.addEventListener("drop", function (event) { chooseFile(event.dataTransfer.files[0]); });

  $("upload-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    if ($("upload-button").disabled) return;
    if (!selectedFile) { status("upload-status", "Choose a photo first.", "error"); return; }
    var file = selectedFile;
    var labels = $("custom-labels").value.split(",").map(function (value) { return value.trim(); }).filter(Boolean).join(",");
    if (/[^\x20-\x7e]/.test(labels)) {
      status("upload-status", "Use English letters, numbers, or symbols for custom labels.", "error"); return;
    }
    var button = $("upload-button");
    button.disabled = true;
    try {
      var sdk = client();
      var extension = /\.png$/i.test(file.name) ? "png" : "jpg";
      var contentType = extension === "png" ? "image/png" : "image/jpeg";
      var uniqueId = window.crypto && typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2);
      var filename = "photo-" + uniqueId + "." + extension;
      status("upload-status", "Uploading your photo…");
      await sdk.photosPut({
        "Content-Type": contentType,
        "filename": filename,
        "x-amz-meta-customlabels": labels
      }, file, {});
      status("upload-status", "Uploaded! Your photo will be searchable shortly.", "success");
      if (labels) $("search-query").value = "show me " + labels.split(",")[0];
    } catch (error) {
      status("upload-status", errorMessage(error), "error");
    } finally { button.disabled = false; }
  });

  function addLabels(parent, labels) {
    var container = document.createElement("div");
    container.className = "labels";
    labels.forEach(function (label) {
      var tag = document.createElement("span");
      tag.className = "label-tag";
      tag.textContent = label;
      container.appendChild(tag);
    });
    parent.appendChild(container);
  }

  function renderResults(photos) {
    $("results").replaceChildren();
    $("empty-state").hidden = photos.length > 0;
    $("result-count").textContent = photos.length + (photos.length === 1 ? " photo found" : " photos found");
    photos.forEach(function (photo, index) {
      var parsed;
      try { parsed = new URL(photo.url); } catch (_) { return; }
      if (parsed.protocol !== "https:") return;
      var labels = Array.isArray(photo.labels) ? photo.labels.filter(function (label) { return typeof label === "string"; }) : [];
      var card = document.createElement("article");
      card.className = "photo-card";
      var link = document.createElement("a");
      link.className = "photo-link";
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "Open photo " + (index + 1) + " in a new tab");
      var image = document.createElement("img");
      image.src = parsed.href;
      image.alt = labels.length ? "Photo labeled " + labels.slice(0, 4).join(", ") : "Search result photo";
      image.loading = "lazy";
      image.addEventListener("error", function () {
        link.classList.add("image-error");
        link.textContent = "Preview unavailable. Search again for a fresh link.";
      });
      link.appendChild(image);
      var details = document.createElement("div");
      details.className = "photo-details";
      var title = document.createElement("h4");
      title.textContent = "Moment " + String(index + 1).padStart(2, "0");
      details.appendChild(title);
      addLabels(details, labels.slice(0, 5));
      if (labels.length > 5) {
        var more = document.createElement("details");
        var summary = document.createElement("summary");
        summary.textContent = "+" + (labels.length - 5) + " more labels";
        more.appendChild(summary);
        addLabels(more, labels.slice(5));
        details.appendChild(more);
      }
      card.append(link, details);
      $("results").appendChild(card);
    });
  }

  async function search() {
    if ($("search-button").disabled) return;
    var query = $("search-query").value.trim();
    if (!query) { $("search-query").focus(); return; }
    var button = $("search-button");
    button.disabled = true;
    document.querySelectorAll("[data-query]").forEach(function (item) { item.disabled = true; });
    try {
      var sdk = client();
      $("results").replaceChildren();
      $("empty-state").hidden = true;
      $("result-count").textContent = "Searching…";
      status("search-status", "Finding your moments…");
      var result = await sdk.searchGet({}, null, { queryParams: { q: query } });
      var body = typeof result.data === "string" ? JSON.parse(result.data) : result.data;
      if (!body || !Array.isArray(body.results)) throw new Error("The album returned an unexpected response.");
      renderResults(body.results);
      if (!body.results.length) {
        $("empty-state").querySelector("h3").textContent = "No moments found yet.";
        $("empty-state").querySelector("p").textContent = "Try another label. Newly uploaded photos may take a moment to appear.";
      }
      status("search-status", "Results for “" + query + "”");
    } catch (error) {
      $("result-count").textContent = "Search unavailable";
      status("search-status", errorMessage(error), "error");
    } finally {
      button.disabled = false;
      document.querySelectorAll("[data-query]").forEach(function (item) { item.disabled = false; });
    }
  }

  $("search-form").addEventListener("submit", function (event) { event.preventDefault(); search(); });
  document.querySelectorAll("[data-query]").forEach(function (button) {
    button.addEventListener("click", function () { $("search-query").value = button.dataset.query; search(); });
  });
  if (!window.apigClientFactory) status("search-status", "SDK files are missing. Copy your generated SDK into the sdk folder, then reload.", "error");
})();
