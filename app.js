/**
 * AI Footprint Calculator — app.js
 * Estimation engine, Chart.js visualizations, UI interactions
 *
 * Methodology:
 *   E_q (facility) = α_m × β_l × γ_h × PUE          [kWh/query]
 *   C_q            = E_q × I_grid                     [gCO₂e/query]
 *   W_q            = E_q × (WUE_onsite + EWIF) × 1000 [mL/query]
 *
 * Sources: Luccioni et al. (2023), Ren et al. (2023), Dodge et al. (2022), IEA 2023
 */

'use strict';

/* ================================================================
   1. PARAMETER TABLES (literature-calibrated)
   ================================================================ */

const PARAMS = {
    /** Base server-side energy per query (kWh) by model class
     *  Source: Luccioni et al. (2023), SemiAnalysis estimates */
    models: {
        small:  { name: 'Small LLM (<7B)',    energy: { min: 0.0001, avg: 0.0005, max: 0.001  } },
        medium: { name: 'Medium LLM (7–70B)', energy: { min: 0.001,  avg: 0.003,  max: 0.005  } },
        large:  { name: 'Large LLM (>70B)',   energy: { min: 0.005,  avg: 0.010,  max: 0.020  } },
        image:  { name: 'Image Generation',   energy: { min: 0.010,  avg: 0.040,  max: 0.100  } },
    },

    /** Prompt-length scaling factor (β_l)
     *  Approximated from token count vs. FLOPs literature */
    promptLength: {
        short:    { label: 'Short (<50 tokens)',        factor: 0.70 },
        medium:   { label: 'Medium (50–200 tokens)',    factor: 1.00 },
        long:     { label: 'Long (200–500 tokens)',     factor: 1.50 },
        verylong: { label: 'Very Long (500+ tokens)',   factor: 2.20 },
    },

    /** Hardware efficiency factor (γ_h)
     *  Based on relative FLOPS/W across GPU generations */
    hardware: {
        efficient: { label: 'Modern/Efficient', factor: 0.80 },
        average:   { label: 'Average',          factor: 1.00 },
        older:     { label: 'Older Hardware',   factor: 1.30 },
    },

    /** Grid carbon intensity (gCO₂e/kWh) by region
     *  Source: Dodge et al. (2022), ElectricityMaps, IEA */
    regions: {
        renewable: { name: 'Renewable-heavy', carbon: { min: 50,  avg: 100, max: 150 } },
        eu:        { name: 'EU Average',      carbon: { min: 200, avg: 275, max: 350 } },
        us:        { name: 'US Average',      carbon: { min: 380, avg: 440, max: 500 } },
        india:     { name: 'India',           carbon: { min: 600, avg: 675, max: 750 } },
        coal:      { name: 'Coal-heavy',      carbon: { min: 700, avg: 800, max: 900 } },
    },

    /** Power Usage Effectiveness (PUE) — data-center overhead
     *  Source: IEA Electricity 2023 */
    pue: { min: 1.10, avg: 1.30, max: 1.60 },

    /** Water usage factors (L/kWh)
     *  onsite: direct cooling water (WUE)
     *  ewif:   electricity-withdrawal intensity factor (indirect)
     *  Source: Ren et al. (2023) */
    water: {
        onsite: { min: 0.00, avg: 0.55, max: 2.00 },
        ewif:   { min: 1.30, avg: 3.10, max: 6.00 },
    },
};

/* ================================================================
   2. CASE STUDY PROFILES
   ================================================================ */

const CASE_STUDIES = {
    student: {
        label: 'Student', queries: 40, model: 'medium',
        prompt: 'medium', hw: 'average', region: 'india',
    },
    pro: {
        label: 'Professional', queries: 250, model: 'large',
        prompt: 'long', hw: 'average', region: 'us',
    },
    heavy: {
        label: 'Heavy/Researcher', queries: 500, model: 'large',
        prompt: 'long', hw: 'efficient', region: 'us',
    },
};

/* ================================================================
   3. CALCULATION ENGINE
   ================================================================ */

/**
 * Returns per-query and cumulative metrics with uncertainty ranges.
 * @param {string} model       - model key
 * @param {number} queriesPerDay
 * @param {string} prompt      - prompt length key
 * @param {string} hardware    - hardware key
 * @param {string} region      - region key
 * @returns {{ perQuery, cumulative }}
 */
function calculate(model, queriesPerDay, prompt, hardware, region) {
    const m = PARAMS.models[model];
    const β = PARAMS.promptLength[prompt].factor;
    const γ = PARAMS.hardware[hardware].factor;
    const R = PARAMS.regions[region];
    const P = PARAMS.pue;
    const W = PARAMS.water;

    // Helper: multiply a {min,avg,max} object by a scalar
    const mul = (obj, k) => ({ min: obj.min * k, avg: obj.avg * k, max: obj.max * k });

    // Server-side energy per query (kWh)
    const serverE = mul(m.energy, β * γ);

    // Facility energy (scale by PUE — each endpoint of uncertainty independently)
    const facilityE = {
        min: serverE.min * P.min,
        avg: serverE.avg * P.avg,
        max: serverE.max * P.max,
    };

    // Carbon per query (gCO₂e)
    const carbon = {
        min: facilityE.min * R.carbon.min,
        avg: facilityE.avg * R.carbon.avg,
        max: facilityE.max * R.carbon.max,
    };

    // Water per query (mL) = facilityE [kWh] × total_water_factor [L/kWh] × 1000
    const waterFactor = {
        min: (W.onsite.min + W.ewif.min) * 1000,
        avg: (W.onsite.avg + W.ewif.avg) * 1000,
        max: (W.onsite.max + W.ewif.max) * 1000,
    };
    const water = mul(waterFactor, 1);  // structure ready
    water.min = facilityE.min * waterFactor.min;
    water.avg = facilityE.avg * waterFactor.avg;
    water.max = facilityE.max * waterFactor.max;

    // Cumulative projections
    const periods = { daily: queriesPerDay, monthly: queriesPerDay * 30, yearly: queriesPerDay * 365 };
    const cumulative = {};
    for (const [period, mult] of Object.entries(periods)) {
        cumulative[period] = {
            energy: mul(facilityE, mult),
            carbon: mul(carbon,    mult),
            // water in Litres for cumulative
            water: { min: water.min * mult / 1000, avg: water.avg * mult / 1000, max: water.max * mult / 1000 },
        };
    }

    return { perQuery: { energy: facilityE, carbon, water }, cumulative };
}

/* ================================================================
   4. SMART FORMATTING
   ================================================================ */

function fmt(val) {
    if (val == null || isNaN(val)) return '—';
    if (val === 0)    return '0';
    if (val < 0.0001) return val.toExponential(2);
    if (val < 0.001)  return val.toFixed(6);
    if (val < 0.1)    return val.toFixed(4);
    if (val < 10)     return val.toFixed(3);
    if (val < 1000)   return val.toFixed(1);
    if (val < 1e6)    return (val / 1000).toFixed(2) + 'k';
    return (val / 1e6).toFixed(2) + 'M';
}

function fmtRange(val, decimals) {
    if (val == null || isNaN(val)) return '—';
    if (val < 0.0001) return val.toExponential(2);
    if (val < 0.01)   return val.toFixed(5);
    if (val < 1)      return val.toFixed(4);
    if (val < 100)    return val.toFixed(2);
    return val.toFixed(1);
}

/* ================================================================
   5. CHART INSTANCES
   ================================================================ */

let charts = {};
let currentResults = null;
let timeHorizon = 'monthly';

/** Shared Chart.js default overrides */
function applyChartDefaults() {
    Chart.defaults.color              = '#4a7c59';
    Chart.defaults.borderColor        = 'rgba(74,222,128,0.08)';
    Chart.defaults.font.family        = "'Inter', sans-serif";
    Chart.defaults.font.size          = 11;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
}

function initCharts() {
    applyChartDefaults();

    /* --- 1. Relative Impact Bar Chart --- */
    charts.metrics = new Chart(document.getElementById('metricsChart'), {
        type: 'bar',
        data: {
            labels: ['⚡ Energy', '💨 Carbon', '💧 Water'],
            datasets: [
                {
                    label: 'Min', data: [0, 0, 0], borderRadius: 5, borderWidth: 0,
                    backgroundColor: 'rgba(74,222,128,0.25)',
                },
                {
                    label: 'Avg', data: [0, 0, 0], borderRadius: 5, borderWidth: 0,
                    backgroundColor: 'rgba(74,222,128,0.65)',
                },
                {
                    label: 'Max', data: [0, 0, 0], borderRadius: 5, borderWidth: 0,
                    backgroundColor: 'rgba(74,222,128,0.95)',
                },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend:  { labels: { color: '#86efac', padding: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)}% of worst-case`,
                    },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a7c59', font: { size: 12, weight: '600' } } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#4a7c59', callback: v => v + '%' },
                    title: { display: true, text: '% of worst-case scenario', color: '#4a7c59', font: { size: 10 } },
                },
            },
        },
    });

    /* --- 2. Cumulative Carbon Line Chart --- */
    const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    charts.cumulative = new Chart(document.getElementById('cumulativeChart'), {
        type: 'line',
        data: {
            labels: monthLabels,
            datasets: [
                {
                    label: 'Min', tension: 0.4, borderWidth: 1.5,
                    borderColor: 'rgba(74,222,128,0.35)',
                    backgroundColor: 'rgba(74,222,128,0.04)',
                    fill: '+1', pointRadius: 2, pointHoverRadius: 5,
                    data: new Array(12).fill(0),
                },
                {
                    label: 'Avg', tension: 0.4, borderWidth: 2.5,
                    borderColor: '#4ade80',
                    backgroundColor: 'rgba(74,222,128,0.10)',
                    fill: false, pointRadius: 3, pointHoverRadius: 7,
                    data: new Array(12).fill(0),
                },
                {
                    label: 'Max', tension: 0.4, borderWidth: 1.5,
                    borderColor: 'rgba(74,222,128,0.35)',
                    backgroundColor: 'rgba(74,222,128,0.04)',
                    fill: '-1', pointRadius: 2, pointHoverRadius: 5,
                    data: new Array(12).fill(0),
                },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#86efac', padding: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)} gCO₂e`,
                    },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a7c59' } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#4a7c59', callback: v => fmt(v) },
                    title: { display: true, text: 'Cumulative gCO₂e', color: '#4a7c59', font: { size: 10 } },
                },
            },
        },
    });

    /* --- 3. Sensitivity Horizontal Bar Chart --- */
    charts.sensitivity = new Chart(document.getElementById('sensitivityChart'), {
        type: 'bar',
        data: {
            labels: ['Model Type', 'Grid / Region', 'Prompt Length', 'PUE Range', 'Hardware'],
            datasets: [{
                label: 'Range of possible carbon values (%)',
                data: [0, 0, 0, 0, 0],
                borderRadius: 5, borderWidth: 0,
                backgroundColor: [
                    'rgba(248,113,113,0.75)',
                    'rgba(74,222,128,0.75)',
                    'rgba(251,146,60,0.75)',
                    'rgba(96,165,250,0.75)',
                    'rgba(250,204,21,0.75)',
                ],
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ±${ctx.raw.toFixed(1)}% relative spread in carbon estimate`,
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#4a7c59', callback: v => v + '%' },
                    title: { display: true, text: 'Relative spread in avg carbon estimate (%)', color: '#4a7c59', font: { size: 10 } },
                },
                y: { grid: { display: false }, ticks: { color: '#86efac', font: { size: 11 } } },
            },
        },
    });

    /* --- 4. Case Study Comparison Bar Chart --- */
    charts.caseStudy = new Chart(document.getElementById('caseStudyChart'), {
        type: 'bar',
        data: {
            labels: ['🎓 Student', '💼 Professional', '🔬 Researcher'],
            datasets: [
                {
                    label: 'Min (gCO₂e/month)', data: [0,0,0], borderRadius: 6, borderWidth: 0,
                    backgroundColor: 'rgba(74,222,128,0.35)',
                },
                {
                    label: 'Avg (gCO₂e/month)', data: [0,0,0], borderRadius: 6, borderWidth: 0,
                    backgroundColor: 'rgba(45,212,191,0.70)',
                },
                {
                    label: 'Max (gCO₂e/month)', data: [0,0,0], borderRadius: 6, borderWidth: 0,
                    backgroundColor: 'rgba(251,146,60,0.70)',
                },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#86efac', padding: 14 } },
                tooltip: {
                    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)} gCO₂e/mo` },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a7c59', font: { size: 12 } } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#4a7c59', callback: v => fmt(v) },
                    title: { display: true, text: 'gCO₂e / month', color: '#4a7c59', font: { size: 10 } },
                },
            },
        },
    });
}

/* ================================================================
   6. UI UPDATE FUNCTIONS
   ================================================================ */

function animatePop(el) {
    el.classList.remove('pop');
    void el.offsetWidth;   // force reflow
    el.classList.add('pop');
}

function updateMetricCard(ids, val, maxVal) {
    const { avgId, minId, maxId, barId } = ids;
    const avgEl = document.getElementById(avgId);
    avgEl.textContent = fmt(val.avg);
    document.getElementById(minId).textContent = fmtRange(val.min);
    document.getElementById(maxId).textContent = fmtRange(val.max);
    animatePop(avgEl);

    const pct = Math.min(100, (val.avg / maxVal) * 100);
    document.getElementById(barId).style.width = pct + '%';
}

function updateCumulativePanel(results) {
    const cumul = results.cumulative[timeHorizon];
    const label = timeHorizon.charAt(0).toUpperCase() + timeHorizon.slice(1);
    document.getElementById('period-label').textContent = label;
    document.getElementById('cumul-energy').textContent = fmt(cumul.energy.avg);
    document.getElementById('cumul-carbon').textContent = fmt(cumul.carbon.avg);
    document.getElementById('cumul-water').textContent  = fmt(cumul.water.avg);
    document.getElementById('equiv-period').textContent = timeHorizon;
}

function updateEquivalents(results) {
    const cumul = results.cumulative[timeHorizon];

    // Phone charges: energy / 0.01 kWh
    const phones = Math.round(cumul.energy.avg / 0.01);
    document.getElementById('eq-phone').textContent = phones.toLocaleString();

    // Car km: carbon / 192 gCO₂e per km
    const carKm = (cumul.carbon.avg / 192);
    document.getElementById('eq-car').textContent = fmt(carKm);

    // Water bottles (500 mL): cumul water in Litres / 0.5
    const bottles = Math.round(cumul.water.avg / 0.5);
    document.getElementById('eq-water').textContent = bottles.toLocaleString();

    // Trees needed to offset (yearly): yearlyCarbon / 21000 gCO₂ per tree per year
    const yearlyCarbon = results.cumulative.yearly.carbon.avg;
    const trees = (yearlyCarbon / 21000);
    document.getElementById('eq-tree').textContent = trees < 0.001 ? trees.toExponential(2) : fmtRange(trees);

    // Household electricity % (yearly): yearlyEnergy / 3500 kWh × 100
    const yearlyEnergy = results.cumulative.yearly.energy.avg;
    const housePct = (yearlyEnergy / 3500) * 100;
    document.getElementById('eq-house').textContent = housePct < 0.01
        ? housePct.toExponential(2) + '%'
        : fmtRange(housePct) + '%';
}

function updateMetricsChart(results) {
    // Worst-case maximums for normalization
    const worstE = PARAMS.models.image.energy.max * PARAMS.promptLength.verylong.factor * PARAMS.hardware.older.factor * PARAMS.pue.max;
    const worstC = worstE * PARAMS.regions.coal.carbon.max;
    const worstW = worstE * (PARAMS.water.onsite.max + PARAMS.water.ewif.max) * 1000;

    const pq = results.perQuery;
    const pct = (v, w) => Math.min(100, (v / w) * 100);

    charts.metrics.data.datasets[0].data = [pct(pq.energy.min, worstE), pct(pq.carbon.min, worstC), pct(pq.water.min, worstW)];
    charts.metrics.data.datasets[1].data = [pct(pq.energy.avg, worstE), pct(pq.carbon.avg, worstC), pct(pq.water.avg, worstW)];
    charts.metrics.data.datasets[2].data = [pct(pq.energy.max, worstE), pct(pq.carbon.max, worstC), pct(pq.water.max, worstW)];
    charts.metrics.update('active');
}

function updateCumulativeChart(results, queriesPerDay) {
    const minPerMonth  = results.perQuery.carbon.min * queriesPerDay * 30;
    const avgPerMonth  = results.perQuery.carbon.avg * queriesPerDay * 30;
    const maxPerMonth  = results.perQuery.carbon.max * queriesPerDay * 30;

    charts.cumulative.data.datasets[0].data = Array.from({ length: 12 }, (_, i) => minPerMonth * (i + 1));
    charts.cumulative.data.datasets[1].data = Array.from({ length: 12 }, (_, i) => avgPerMonth * (i + 1));
    charts.cumulative.data.datasets[2].data = Array.from({ length: 12 }, (_, i) => maxPerMonth * (i + 1));
    charts.cumulative.update('active');
}

function updateSensitivityChart(model, prompt, hw, region, queries) {
    const base = calculate(model, queries, prompt, hw, region).perQuery.carbon.avg;
    if (!base || base === 0) return;

    const spread = (keys, fn) => {
        const vals = keys.map(fn);
        return ((Math.max(...vals) - Math.min(...vals)) / base) * 100;
    };

    const modelSpread  = spread(['small','medium','large','image'],         k => calculate(k,     queries, prompt, hw,     region).perQuery.carbon.avg);
    const regionSpread = spread(['renewable','eu','us','india','coal'],      k => calculate(model, queries, prompt, hw,     k     ).perQuery.carbon.avg);
    const promptSpread = spread(['short','medium','long','verylong'],        k => calculate(model, queries, k,      hw,     region).perQuery.carbon.avg);
    const hwSpread     = spread(['efficient','average','older'],             k => calculate(model, queries, prompt, k,      region).perQuery.carbon.avg);

    // PUE spread: manual (fix all, vary only PUE)
    const serverE     = PARAMS.models[model].energy.avg * PARAMS.promptLength[prompt].factor * PARAMS.hardware[hw].factor;
    const pueSpread   = ((serverE * PARAMS.pue.max - serverE * PARAMS.pue.min) * PARAMS.regions[region].carbon.avg / base) * 100;

    charts.sensitivity.data.datasets[0].data = [
        Math.min(modelSpread,  999),
        Math.min(regionSpread, 999),
        Math.min(promptSpread, 999),
        Math.min(pueSpread,    999),
        Math.min(hwSpread,     999),
    ];
    charts.sensitivity.update('active');
}

function updateCaseStudies() {
    const profiles = Object.entries(CASE_STUDIES);
    const csResults = {};
    profiles.forEach(([key, p]) => {
        csResults[key] = calculate(p.model, p.queries, p.prompt, p.hw, p.region);
    });

    // Student
    document.getElementById('cs-student-energy').textContent = fmt(csResults.student.cumulative.daily.energy.avg)  + ' kWh/day';
    document.getElementById('cs-student-carbon').textContent = fmt(csResults.student.cumulative.monthly.carbon.avg) + ' gCO₂e/mo';
    document.getElementById('cs-student-water').textContent  = fmt(csResults.student.cumulative.monthly.water.avg)  + ' L/mo';

    // Professional
    document.getElementById('cs-pro-energy').textContent = fmt(csResults.pro.cumulative.daily.energy.avg)   + ' kWh/day';
    document.getElementById('cs-pro-carbon').textContent = fmt(csResults.pro.cumulative.monthly.carbon.avg)  + ' gCO₂e/mo';
    document.getElementById('cs-pro-water').textContent  = fmt(csResults.pro.cumulative.monthly.water.avg)   + ' L/mo';

    // Heavy
    document.getElementById('cs-heavy-energy').textContent = fmt(csResults.heavy.cumulative.daily.energy.avg)   + ' kWh/day';
    document.getElementById('cs-heavy-carbon').textContent = fmt(csResults.heavy.cumulative.monthly.carbon.avg)  + ' gCO₂e/mo';
    document.getElementById('cs-heavy-water').textContent  = fmt(csResults.heavy.cumulative.monthly.water.avg)   + ' L/mo';

    // Case study chart
    charts.caseStudy.data.datasets[0].data = [
        csResults.student.cumulative.monthly.carbon.min,
        csResults.pro.cumulative.monthly.carbon.min,
        csResults.heavy.cumulative.monthly.carbon.min,
    ];
    charts.caseStudy.data.datasets[1].data = [
        csResults.student.cumulative.monthly.carbon.avg,
        csResults.pro.cumulative.monthly.carbon.avg,
        csResults.heavy.cumulative.monthly.carbon.avg,
    ];
    charts.caseStudy.data.datasets[2].data = [
        csResults.student.cumulative.monthly.carbon.max,
        csResults.pro.cumulative.monthly.carbon.max,
        csResults.heavy.cumulative.monthly.carbon.max,
    ];
    charts.caseStudy.update('active');
}

/* ================================================================
   7. MASTER UPDATE — called on every input change
   ================================================================ */

function updateAll() {
    const model   = document.getElementById('model-type').value;
    const queries = parseInt(document.getElementById('queries-per-day').value, 10);
    const prompt  = document.getElementById('prompt-length').value;
    const hw      = document.getElementById('hardware').value;
    const region  = document.getElementById('region').value;

    const results = calculate(model, queries, prompt, hw, region);
    currentResults = results;

    // Worst-case maxes for relative bar within metric cards
    const maxE = PARAMS.models.image.energy.max * PARAMS.promptLength.verylong.factor * PARAMS.hardware.older.factor * PARAMS.pue.max;
    const maxC = maxE * PARAMS.regions.coal.carbon.max;
    const maxW = maxE * (PARAMS.water.onsite.max + PARAMS.water.ewif.max) * 1000;

    updateMetricCard({ avgId:'energy-avg', minId:'energy-min', maxId:'energy-max', barId:'energy-bar' }, results.perQuery.energy, maxE);
    updateMetricCard({ avgId:'carbon-avg', minId:'carbon-min', maxId:'carbon-max', barId:'carbon-bar' }, results.perQuery.carbon, maxC);
    updateMetricCard({ avgId:'water-avg',  minId:'water-min',  maxId:'water-max',  barId:'water-bar'  }, results.perQuery.water,  maxW);

    updateCumulativePanel(results);
    updateEquivalents(results);
    updateMetricsChart(results);
    updateCumulativeChart(results, queries);
    updateSensitivityChart(model, prompt, hw, region, queries);
}

/* ================================================================
   8. EVENT LISTENERS & INIT
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
    initCharts();

    // Input controls
    document.getElementById('model-type').addEventListener('change', updateAll);
    document.getElementById('prompt-length').addEventListener('change', updateAll);
    document.getElementById('hardware').addEventListener('change', updateAll);
    document.getElementById('region').addEventListener('change', updateAll);

    document.getElementById('queries-per-day').addEventListener('input', e => {
        document.getElementById('queries-display').textContent = e.target.value;
        updateAll();
    });

    // Time horizon toggle
    document.querySelectorAll('.btn-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            timeHorizon = btn.dataset.value;
            if (currentResults) {
                updateCumulativePanel(currentResults);
                updateEquivalents(currentResults);
            }
        });
    });

    // Floating tooltips
    const tooltipEl = document.getElementById('tooltip-popup');
    document.querySelectorAll('[data-tooltip]').forEach(el => {
        el.addEventListener('mouseenter', () => {
            tooltipEl.textContent = el.dataset.tooltip;
            tooltipEl.setAttribute('aria-hidden', 'false');
            tooltipEl.classList.add('visible');
        });
        el.addEventListener('mousemove', e => {
            const x = Math.min(e.clientX + 14, window.innerWidth - tooltipEl.offsetWidth - 10);
            const y = e.clientY - 12;
            tooltipEl.style.left = x + 'px';
            tooltipEl.style.top  = y + 'px';
        });
        el.addEventListener('mouseleave', () => {
            tooltipEl.classList.remove('visible');
            tooltipEl.setAttribute('aria-hidden', 'true');
        });
        // Keyboard accessibility
        el.addEventListener('focus', e => {
            tooltipEl.textContent = el.dataset.tooltip;
            tooltipEl.classList.add('visible');
            const rect = el.getBoundingClientRect();
            tooltipEl.style.left = rect.left + 'px';
            tooltipEl.style.top  = (rect.bottom + 6) + 'px';
        });
        el.addEventListener('blur', () => tooltipEl.classList.remove('visible'));
    });

    // Run case studies (static, computed once)
    updateCaseStudies();

    // Initial full calculation
    updateAll();
});
