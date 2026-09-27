# Third-party data in this repo

The code is MIT (see `LICENSE`). The test fixtures contain data from these sources:

| Data | Where | Licence | Notes |
|---|---|---|---|
| VicEmergency data | `fixtures/events-*.json`, `fixtures/osom-fdrtfb-*.json` | CC BY 3.0 AU | © State of Victoria, Australia (Emergency Management Victoria), [emergency data notice](https://www.emv.vic.gov.au/responsibilities/victorias-warning-system/emergency-data). Test snapshots, scrubbed of contact details and warning text; the 2025–26 archive days come from [jamesmstone/vicemergency](https://github.com/jamesmstone/vicemergency). |
| CFA fire danger RSS | `fixtures/cfa-tfbfdr-*.xml` | CC BY 4.0 | Country Fire Authority, via DataVic. Test snapshot. |
| Vicmap Admin | `fixtures/vicmap-*.json` | CC BY 4.0 | State of Victoria (DEECA), via DataVic. Test snapshot. |
| Bureau of Meteorology product shapes | `fixtures/IDV185*-sample.xml` | — | Synthetic test data in the shape of IDV18555 / IDV18560, with invented values; not Bureau of Meteorology data. BoM products are personal-use only, so live captures (`npm run capture`) go to the gitignored `fixtures/local/`. |
| Open-Meteo | `fixtures/open-meteo-*.json` | CC BY 4.0 | Weather data by [Open-Meteo.com](https://open-meteo.com). Test snapshot. |
