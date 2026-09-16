# Third-party notices

AI Bro Mobile is part of AI Bro, licensed under AGPL-3.0-only. See the repository LICENSE. The app's source, including these modifications, is available with the product source.

## UCAS course integration

`src/ucas.js` adapts the school API contracts and response interpretation reviewed in:

- **UCAS-Sign-in**, zhan-nine: https://github.com/zhan-nine/UCAS-Sign-in — GNU Affero General Public License v3.0.
- **UCAS-Course-Sign-in**, lccipher: https://github.com/lccipher/UCAS-Course-Sign-in — GNU Affero General Public License v3.0, credited by UCAS-Sign-in's NOTICE.

The mobile implementation uses a separate school session in the iOS Keychain, explicit password login, course retrieval, timestamp validation and user-initiated attendance submission, explicit opt-in foreground attendance, course time selection and time-aligned QR generation. Reviewed upstream commit: `92dcea4d683603a57ac16d88c61bb0a05b20c6c8` (1.1.8, 2026-09-16). It does not incorporate the upstream Android service, identity-only login, or automatic background attendance scheduler. It is not an official UCAS client.

Upstream license and notice copies are retained under `native/licenses/ucas/`. Review the upstream distribution notices before redistributing any additional upstream assets or code.

## Dependencies

Runtime and build dependencies are pinned in `package-lock.json`; Swift package resolution is retained in the Xcode project. Their original license files are included in their packages:

- Capacitor and official Capacitor plugins — MIT.
- Vite — MIT.
- Marked — MIT; DOMPurify — Apache-2.0 OR MPL-2.0.
- ical.js — MPL-2.0.
- @js-temporal/polyfill — ISC; JSBI — Apache-2.0 (time zone and recurrence arithmetic).
- jsdiff — BSD-3-Clause.
- qrcode — MIT.
- fflate — MIT.
- node-xcode (project setup utility) — Apache-2.0.
- Playwright (development tests) — Apache-2.0.
