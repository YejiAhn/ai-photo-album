/* Version 2: preserve binary payloads before BOTH generated SDK layers.
 * Keep this file after all SDK scripts and before app.js in index.html.
 * Both search and upload still use the generated SDK methods.
 */
(function () {
  "use strict";
  var core = window.apiGateway && window.apiGateway.core;
  if (!core || !core.utils || !core.simpleHttpClientFactory || !core.apiGatewayClientFactory) return;

  function isBinary(value) {
    return value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
  }

  var originalCopy = core.utils.copy;
  core.utils.copy = function copy(value) {
    if (value === null || value === undefined) return value;
    if (isBinary(value)) return value;
    if (Array.isArray(value)) return value.map(copy);
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      var result = {};
      Object.keys(value).forEach(function (key) {
        Object.defineProperty(result, key, { value: copy(value[key]), enumerable: true, writable: true, configurable: true });
      });
      return result;
    }
    return typeof value === "object" ? originalCopy(value) : value;
  };

  var originalNewClient = core.simpleHttpClientFactory.newClient;
  core.simpleHttpClientFactory.newClient = function (config) {
    var client = originalNewClient(config);
    var originalMakeRequest = client.makeRequest;
    client.makeRequest = function (request) {
      var body = request.body;
      if (!isBinary(body)) {
        return originalMakeRequest.call(client, request);
      }
      var url = new URL(config.endpoint + request.path);
      Object.keys(request.queryParams || {}).forEach(function (key) {
        var value = request.queryParams[key];
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
      });
      var headers = new Headers();
      Object.keys(request.headers || {}).forEach(function (key) {
        var value = request.headers[key];
        if (value !== undefined && value !== null) headers.set(key, value);
      });
      if (!headers.has("Content-Type")) headers.set("Content-Type", config.defaultContentType || "application/octet-stream");
      if (!headers.has("Accept")) headers.set("Accept", config.defaultAcceptType || "application/json");
      return fetch(url.toString(), {
        method: request.verb,
        headers: headers,
        body: body,
        credentials: "omit"
      }).then(async function (response) {
        var text = await response.text();
        var data = text;
        if (text) { try { data = JSON.parse(text); } catch (_) { /* S3 errors can be XML. */ } }
        var result = { data: data, status: response.status, statusText: response.statusText, headers: {} };
        response.headers.forEach(function (value, key) { result.headers[key] = value; });
        if (!response.ok) {
          var error = new Error("Upload failed (HTTP " + response.status + ").");
          error.response = result;
          throw error;
        }
        return result;
      });
    };
    return client;
  };

  // apiGatewayClient.js clears bodies with Object.keys(body).length === 0.
  // Files and Blobs normally have no enumerable keys despite containing bytes.
  // Handle binary bodies before they reach that generated empty-object check.
  var originalGatewayNewClient = core.apiGatewayClientFactory.newClient;
  core.apiGatewayClientFactory.newClient = function (simpleConfig, sigV4Config) {
    var gateway = originalGatewayNewClient(simpleConfig, sigV4Config);
    var originalMakeRequest = gateway.makeRequest;
    var binaryTransport = core.simpleHttpClientFactory.newClient(simpleConfig);
    gateway.makeRequest = function (request, authType, additionalParams, apiKey) {
      if (!isBinary(request.body)) {
        return originalMakeRequest.call(gateway, request, authType, additionalParams, apiKey);
      }
      if (authType === "AWS_IAM") {
        return Promise.reject(new Error("This binary upload adapter uses API key authorization. Remove AWS credentials from the frontend SDK configuration."));
      }
      var extra = additionalParams || {};
      var binaryRequest = {
        verb: request.verb,
        path: request.path,
        headers: Object.assign({}, request.headers || {}),
        queryParams: Object.assign({}, request.queryParams || {}, extra.queryParams || {}),
        body: request.body
      };
      if (apiKey) binaryRequest.headers["x-api-key"] = apiKey;
      Object.assign(binaryRequest.headers, extra.headers || {});
      return binaryTransport.makeRequest(binaryRequest);
    };
    return gateway;
  };
  window.FRAME_SDK_BINARY_VERSION = 2;
})();
