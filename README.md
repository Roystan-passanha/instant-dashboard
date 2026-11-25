# Instant Dashboard

![tests](https://github.com/Roystan-passanha/instant-dashboard/actions/workflows/tests.yml/badge.svg)

Upload an Excel or CSV file and get a dashboard. The site cleans the file, picks a starting set of charts, explains why it suggests each one, and asks a few questions so you can correct its guesses.

**Live site:** https://roystan-passanha.github.io/instant-dashboard/

The file is read inside the browser. Nothing is uploaded.

## What happens when you drop a file

1. **Cleaning.** Mixed date formats, numbers stored as text, spelling variants (`Dubai`, `dubai`, `DUBAI `), duplicates and empty rows are fixed first, using the same logic as my [Data Cleaner](https://github.com/Roystan-passanha/data-cleaner).
2. **Reading the columns.** Each column gets a role: a number to measure, a date, a group to compare by, or a long list such as customers that only makes sense as a top 10.
3. **A starter dashboard.** Headline numbers, a trend over time, breakdowns by group and a spread chart.
4. **Questions.** Which number matters most? Should it be added up or averaged? Which date says when things happened? What do you want to compare by? Each answer redraws the dashboard.
5. **Suggested charts.** A list of every chart that fits the data, each with the reason it was suggested. Tick to add, untick to remove.
6. **What stands out.** Plain sentences worked out from the numbers: the largest share, the best and worst period, whether the second half of the period is higher than the first, and rows with unusually large values.

Two add-ons can be switched on or off in the sidebar:

- **Forecast.** The trend line is extended a few periods ahead as a dashed estimate with a likely range. It is a straight-line fit, so it ignores seasons and one-off events, and it is only shown with at least 30 rows and 6 periods.
- **Click a bar for details.** Clicking a name in any bar chart (a sales rep, a region, a product) opens its totals, its rank and share, what it is made of in the other columns (for a sales rep: how many customers and which ones bring in the most), and its own trend. One more click filters the whole dashboard to that name.

Filters sit above the charts. Every chart has a table view and a hover tooltip. "Print or save as PDF" gives a clean copy to send.

## How it is built

Plain HTML, CSS and JavaScript with no build step and no chart library.

| File | What it is |
| --- | --- |
| `js/analyze.js` | Column roles, grouping, time series, histogram bins, suggestions and findings, as pure functions |
| `js/charts.js` | SVG line, bar and column charts with tooltips |
| `js/cleaner.js` | Cleaning logic shared with Data Cleaner |
| `js/app.js` | File reading, questions, filters, details panel and layout |
| `js/hero.js` | Particle animation on the landing page |
| `tests/` | Tests for the analysis logic (`npm test`, Node 20+) |
| `vendor/` | SheetJS, which reads Excel files |

Chart rules it follows: bars for comparisons and never pies, one axis per chart, at most four colours on a trend with the rest grouped as "Other", and a colour set checked for colour-blind readers in light and dark mode.

The suggestions and findings come from fixed rules, not from an AI model, so the same file always gives the same dashboard.

## Run it locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
npm test
```

## Licence

MIT. SheetJS Community Edition is Apache-2.0.

## Pick columns

The "Pick columns" button keeps only the columns you tick (for example Customer ID and Phone Number out of a master sheet), with optional sorting and removal of repeated rows, and downloads the result as Excel or CSV. Phone numbers keep their leading zero in the Excel download.

## Chart types

Each chart has a type menu. Category charts: bars, columns, pie, donut, rose, funnel, treemap, radar. Trends: line, smooth line, area, step line, columns, and stacked area or stacked columns when the trend is split into groups. Every chart can also be shown as a table. The extra types are drawn with [Apache ECharts](https://echarts.apache.org/) (Apache-2.0, see `vendor/`), loaded only when one is picked. When the sheet has two or more number columns, a scatter chart of one against the other is suggested, with a plain sentence on how strongly they are linked.
