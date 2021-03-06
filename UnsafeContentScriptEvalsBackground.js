/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global browser */

const ContentScriptURL = new URL(document.currentScript.src).
                           pathname.replace("Background", "Content");

const SecureAllowEvalsToken = crypto.getRandomValues(new Uint32Array(4)).join("");

const UnsafeContentScriptEvals = (function() {
  "use strict";

  const ScriptSrcAllowsEval = new RegExp("script-src[^;]*'unsafe-eval'", "i");
  const DefaultSrcAllowsEval = new RegExp("default-src[^;]*'unsafe-eval'", "i");
  const DefaultSrcGetRE = new RegExp("default-src([^;]*)", "i");

  const ActiveConfigContentScripts = {};

  async function unregisterConfigContentScript(url) {
    const cs = ActiveConfigContentScripts[url];
    if (cs) {
      try {
        await cs.unregister();
      } catch (e) {}
      delete ActiveConfigContentScripts[url];
    }
  }

  function messageHandler(msg, sender, sendResponse) {
    const url = msg.unregisterFor;
    if (url) {
      unregisterConfigContentScript(url);
    }
  }

  async function headerHandler(details) {
    const {url} = details;

    let CSP;
    let reportOnlyCSP;
    const responseHeaders = [];
    for (const header of details.responseHeaders) {
      const name = header.name.toLowerCase();
      const reportOnly = name === "content-security-policy-report-only";
      if (reportOnly || name === "content-security-policy") {
        let effectiveDirective;
        const originalValue = header.value;
        if (header.value.includes("script-src ")) {
          if (!header.value.match(ScriptSrcAllowsEval)) {
            effectiveDirective = "script-src";
            header.value = header.value.
              replace("script-src", "script-src 'unsafe-eval'");
          }
        } else if (header.value.includes("default-src") &&
                   !header.value.match(DefaultSrcAllowsEval)) {
          effectiveDirective = "default-src";
          const defaultSrcs = header.value.match(DefaultSrcGetRE)[1];
          header.value = header.value.replace("default-src",
            `script-src 'unsafe-eval' ${defaultSrcs}; default-src`);
        }
        if (effectiveDirective) {
          const csp = {
            violatedDirective: effectiveDirective,
            effectiveDirective,
            disposition: reportOnly ? "report" : "enforce",
            originalPolicy: originalValue,
            documentURI: url,
          };
          if (reportOnly) {
            reportOnlyCSP = csp;
          } else {
            CSP = csp;
          }
        }
      }
      responseHeaders.push(header);
    }

    if (CSP || reportOnlyCSP) {
      // Ideally, we would just do a browser.tabs.executeScript here for just
      // the frame running at document_start, but that doesn't work (it runs
      // far too late). However, using contentScripts.register does run early
      // enough, so we use that instead (and make sure it only runs for the
      // webRequest's URL, and is deactivated as soon as the content script
      // uses window.eval to setup the page script).
      await unregisterConfigContentScript(url);
      const code = `BlockUnsafeEvals(${JSON.stringify(url)},
                                     ${JSON.stringify(CSP)},
                                     ${JSON.stringify(reportOnlyCSP)},
                                     ${JSON.stringify(SecureAllowEvalsToken)},
                                     ${!window.UnsafeContentScriptEvalsBlockReports})`;
      ActiveConfigContentScripts[url] = await browser.contentScripts.register({
        allFrames: true,
        matches: [url],
        js: [{file: ContentScriptURL}, {code}],
        runAt: "document_start",
      });
    }

    return {responseHeaders};
  }

  let Filters;

  function allow(filters = {urls: ["<all_urls>"]}) {
    if (Filters) {
      useCSPDefaults();
    }

    filters.types = ["main_frame", "sub_frame"];
    Filters = filters;

    browser.runtime.onMessage.addListener(messageHandler);

    browser.webRequest.onHeadersReceived.addListener(
      headerHandler,
      Filters,
      ["blocking", "responseHeaders"]
    );

    return SecureAllowEvalsToken;
  }

  function useCSPDefaults() {
    if (Filters) {
      browser.runtime.onMessage.removeListener(messageHandler);

      browser.webRequest.onHeadersReceived.removeListener(
        headerHandler,
        Filters,
        ["blocking", "responseHeaders"]
      );

      Filters = undefined;
    }
  }

  return {
    allow,
    useCSPDefaults,
  };
}());
