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

    // Water per query (mL)
    // Correct Li et al. formula: W = E_server × ρ_s1 + E_facility × ρ_s2
    // On-site water (ρ_s1) scales with server energy (cooling the chips)
    // Off-site water (ρ_s2) scales with facility energy (power plant water)
    const water = {
        min: (serverE.min * W.onsite.min + facilityE.min * W.ewif.min) * 1000,
        avg: (serverE.avg * W.onsite.avg + facilityE.avg * W.ewif.avg) * 1000,
        max: (serverE.max * W.onsite.max + facilityE.max * W.ewif.max) * 1000,
    };

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
    Chart.defaults.color              = '#3d6b42';
    Chart.defaults.borderColor        = 'rgba(22,163,74,0.1)';
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
                    backgroundColor: 'rgba(22,163,74,0.2)',
                },
                {
                    label: 'Avg', data: [0, 0, 0], borderRadius: 5, borderWidth: 0,
                    backgroundColor: 'rgba(22,163,74,0.5)',
                },
                {
                    label: 'Max', data: [0, 0, 0], borderRadius: 5, borderWidth: 0,
                    backgroundColor: 'rgba(22,163,74,0.85)',
                },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend:  { labels: { color: '#16a34a', padding: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)}% of worst-case`,
                    },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#6b9a70', font: { size: 12, weight: '600' } } },
                y: {
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: { color: '#6b9a70', callback: v => v + '%' },
                    title: { display: true, text: '% of worst-case scenario', color: '#6b9a70', font: { size: 10 } },
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
                    borderColor: 'rgba(22,163,74,0.25)',
                    backgroundColor: 'rgba(22,163,74,0.04)',
                    fill: '+1', pointRadius: 2, pointHoverRadius: 5,
                    data: new Array(12).fill(0),
                },
                {
                    label: 'Avg', tension: 0.4, borderWidth: 2.5,
                    borderColor: '#16a34a',
                    backgroundColor: 'rgba(22,163,74,0.08)',
                    fill: false, pointRadius: 3, pointHoverRadius: 7,
                    data: new Array(12).fill(0),
                },
                {
                    label: 'Max', tension: 0.4, borderWidth: 1.5,
                    borderColor: 'rgba(22,163,74,0.25)',
                    backgroundColor: 'rgba(22,163,74,0.04)',
                    fill: '-1', pointRadius: 2, pointHoverRadius: 5,
                    data: new Array(12).fill(0),
                },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#16a34a', padding: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)} gCO₂e`,
                    },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#6b9a70' } },
                y: {
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: { color: '#6b9a70', callback: v => fmt(v) },
                    title: { display: true, text: 'Cumulative gCO₂e', color: '#6b9a70', font: { size: 10 } },
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
                    'rgba(220,38,38,0.65)',
                    'rgba(22,163,74,0.65)',
                    'rgba(234,88,12,0.65)',
                    'rgba(37,99,235,0.65)',
                    'rgba(202,138,4,0.65)',
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
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: { color: '#6b9a70', callback: v => v + '%' },
                    title: { display: true, text: 'Relative spread in avg carbon estimate (%)', color: '#6b9a70', font: { size: 10 } },
                },
                y: { grid: { display: false }, ticks: { color: '#16a34a', font: { size: 11 } } },
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
                    backgroundColor: 'rgba(22,163,74,0.25)',
                },
                {
                    label: 'Avg (gCO₂e/month)', data: [0,0,0], borderRadius: 6, borderWidth: 0,
                    backgroundColor: 'rgba(13,148,136,0.6)',
                },
                {
                    label: 'Max (gCO₂e/month)', data: [0,0,0], borderRadius: 6, borderWidth: 0,
                    backgroundColor: 'rgba(234,88,12,0.6)',
                },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#16a34a', padding: 14 } },
                tooltip: {
                    callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw)} gCO₂e/mo` },
                },
            },
            scales: {
                x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#6b9a70', font: { size: 12 } } },
                y: {
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    ticks: { color: '#6b9a70', callback: v => fmt(v) },
                    title: { display: true, text: 'gCO₂e / month', color: '#6b9a70', font: { size: 10 } },
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

    // Ctrl+Enter shortcut for prompt analysis
    document.getElementById('user-prompt').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); analyzePrompt(); }
    });
});

/* ================================================================
   9. PROMPT-LEVEL ANALYSIS ENGINE
   Uses empirically measured α_m from Kaggle T4 + CodeCarbon
   ================================================================ */

const MEASURED_MODELS = {
    'flan-t5-base': {
        alpha_m: 6.4e-5,       // kWh/query — measured with CodeCarbon on Kaggle T4
        ref_output: 104.0,     // avg output tokens in calibration dataset
        ref_input: 37.96,      // avg input tokens in calibration dataset
        type: 'seq2seq',
        params: '250M',
        label: 'Flan-T5 Base',
    },
    'qwen-0.5b': {
        alpha_m: 1.83e-4,      // kWh/query — measured with CodeCarbon on Kaggle T4
        ref_output: 154.8,
        ref_input: 64.8,
        type: 'causal',
        params: '500M',
        label: 'Qwen 2.5 0.5B',
    },
};

const PROMPT_REGIONS = {
    renewable: { carbon: 100,  name: 'Renewable' },
    eu:        { carbon: 275,  name: 'EU Average' },
    us:        { carbon: 440,  name: 'US Average' },
    india:     { carbon: 675,  name: 'India' },
    coal:      { carbon: 800,  name: 'Coal-heavy' },
};

// Infrastructure defaults for prompt analysis
const PROMPT_INFRA = {
    pue: 1.20,        // slightly above best-case, realistic
    rho_s1: 0.55,     // Li et al. US avg on-site WUE
    rho_s2: 3.14,     // Li et al. US avg off-site EWIF
};

// Keyword detection for output length prediction
const LEN_KW = {
    very_short: ['one word', 'single word', 'yes or no', 'true or false'],
    short:      ['briefly', 'in short', 'concise', 'one sentence', 'tl;dr'],
    long:       ['in detail', 'detailed', 'step by step', 'step-by-step', 'thoroughly'],
    very_long:  ['comprehensively', 'extensive', 'multiple examples', 'elaborate', 'exhaustive'],
};
const TASK_KW = {
    classification: ['classify', 'sentiment', 'categorize', 'positive or negative', 'label'],
    summarization:  ['summarize', 'summary', 'tldr', 'tl;dr', 'gist'],
    qa:             ['?', 'what is', 'why ', 'how ', 'when ', 'where ', 'who '],
    generation:     ['write', 'create', 'generate', 'compose', 'draft', 'describe', 'explain', 'story'],
};

function countTokensApprox(text) {
    return Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3));
}

function detectTaskType(prompt) {
    const p = prompt.toLowerCase();
    for (const [task, kws] of Object.entries(TASK_KW)) {
        if (kws.some(k => p.includes(k))) return task;
    }
    return 'general';
}

function detectLengthInstruction(prompt) {
    const p = prompt.toLowerCase();
    if (LEN_KW.very_short.some(k => p.includes(k))) return 'very_short';
    if (LEN_KW.short.some(k => p.includes(k)))      return 'short';
    if (LEN_KW.very_long.some(k => p.includes(k)))  return 'very_long';
    if (LEN_KW.long.some(k => p.includes(k)))       return 'long';
    return 'default';
}

function predictBetaL(prompt, modelKey) {
    const p = prompt.toLowerCase();
    const cfg = MEASURED_MODELS[modelKey];

    // Length multiplier
    let lenMul = 1.0;
    if (LEN_KW.very_short.some(k => p.includes(k)))  lenMul = 0.05;
    else if (LEN_KW.short.some(k => p.includes(k)))   lenMul = 0.30;
    else if (LEN_KW.very_long.some(k => p.includes(k))) lenMul = 3.50;
    else if (LEN_KW.long.some(k => p.includes(k)))    lenMul = 2.20;

    // Task multiplier
    let taskMul = 1.0;
    if (TASK_KW.classification.some(k => p.includes(k))) taskMul = 0.15;
    else if (TASK_KW.summarization.some(k => p.includes(k))) taskMul = 0.70;
    else if (TASK_KW.generation.some(k => p.includes(k))) taskMul = 1.80;

    const predicted = cfg.ref_output * lenMul * taskMul;
    return Math.max(0.02, predicted / cfg.ref_output);
}

function computePromptFootprint(prompt, modelKey, regionKey) {
    const cfg = MEASURED_MODELS[modelKey];
    const region = PROMPT_REGIONS[regionKey];
    const infra = PROMPT_INFRA;

    const beta_l = predictBetaL(prompt, modelKey);
    const gamma_h = 1.0; // measured on deployment hardware
    const inputTokens = countTokensApprox(prompt);
    const predictedOutput = Math.round(cfg.ref_output * beta_l);

    // Formula chain: E_q = α_m × β_ℓ × γ_h × PUE
    const E_server = cfg.alpha_m * beta_l * gamma_h;
    const E_facility = E_server * infra.pue;
    const C_q = E_facility * region.carbon;
    // Li et al.: W = E_server × ρ_s1 + E_facility × ρ_s2
    const W_q_liters = E_server * infra.rho_s1 + E_facility * infra.rho_s2;
    const W_q_ml = W_q_liters * 1000;

    return {
        beta_l, inputTokens, predictedOutput,
        E_server, E_facility, C_q, W_q_ml,
        phoneCharges: E_facility / 0.022,
        drivingMeters: (C_q / 404) * 1609,
        waterCups: W_q_ml / 240,
        task: detectTaskType(prompt),
        lengthInst: detectLengthInstruction(prompt),
    };
}

function splitPromptPhrases(prompt) {
    return prompt.split(/([.!?,;:]|\s(?:and|but|or|with)\s)/i)
        .map(p => p.trim())
        .filter(p => p.length > 3 && !/^[.!?,;:]$/.test(p));
}

function computePromptAttributions(prompt, modelKey, regionKey) {
    const baseline = computePromptFootprint(prompt, modelKey, regionKey);
    const phrases = splitPromptPhrases(prompt);
    const results = [];
    for (const phrase of phrases) {
        const ablated = prompt.replace(phrase, '').replace(/\s{2,}/g, ' ').trim();
        if (ablated.length < 5) continue;
        const abl = computePromptFootprint(ablated, modelKey, regionKey);
        const dc = baseline.C_q - abl.C_q;
        const dw = baseline.W_q_ml - abl.W_q_ml;
        if (Math.abs(dc) > 0.00001) results.push({ phrase, deltaCarbon: dc, deltaWater: dw });
    }
    results.sort((a, b) => Math.abs(b.deltaCarbon) - Math.abs(a.deltaCarbon));
    return results.slice(0, 8);
}

function getPromptSuggestions(prompt, modelKey, result) {
    const s = [];
    const p = prompt.toLowerCase();
    const mtype = MEASURED_MODELS[modelKey].type;

    if (['default', 'long', 'very_long'].includes(result.lengthInst)) {
        const pct = result.lengthInst === 'very_long' ? 75 : result.lengthInst === 'long' ? 50 : 30;
        s.push({ icon: '✂️', text: 'Add "Answer briefly" or "Answer in 2 sentences" to constrain output length.', savings: pct });
    }
    if (result.task === 'classification' && mtype === 'causal') {
        s.push({ icon: '🔄', text: 'Classification tasks run ~200× cheaper on a small BERT model (e.g. distilbert-sst2). Source: Luccioni et al. Fig 3.', savings: 99 });
    }
    if (p.includes('step by step') || p.includes('in detail')) {
        s.push({ icon: '📝', text: 'Remove "in detail" / "step by step" — these roughly double output length and energy. Source: our calibration β_ℓ coefficient.', savings: 50 });
    }
    if (p.includes('example') || p.includes('examples')) {
        s.push({ icon: '💡', text: 'Requesting "examples" increases output significantly. Consider asking for just one.', savings: 30 });
    }
    if (s.length === 0) {
        s.push({ icon: '✅', text: 'Your prompt looks reasonably efficient. No major savings detected.', savings: 0 });
    }
    return s;
}

/* ── Main analyze function ── */
function analyzePrompt() {
    const prompt = document.getElementById('user-prompt').value.trim();
    if (!prompt) return;

    const modelKey = document.getElementById('prompt-model').value;
    const regionKey = document.getElementById('prompt-region').value;
    const cfg = MEASURED_MODELS[modelKey];
    const region = PROMPT_REGIONS[regionKey];

    const r = computePromptFootprint(prompt, modelKey, regionKey);
    const attrs = computePromptAttributions(prompt, modelKey, regionKey);
    const suggs = getPromptSuggestions(prompt, modelKey, r);

    // Show results area
    document.getElementById('prompt-results').classList.remove('hidden');

    // Badges
    document.getElementById('prompt-badges').innerHTML = [
        ['Task', r.task],
        ['Length', r.lengthInst.replace('_', ' ')],
        ['β_ℓ', r.beta_l.toFixed(2)],
        ['Tokens (in)', r.inputTokens],
        ['Tokens (out est.)', r.predictedOutput],
        ['Model', cfg.label + ' (' + cfg.params + ')'],
        ['Architecture', cfg.type],
        ['Region', region.name],
    ].map(([l, v]) => `<span class="p-badge"><span class="p-badge-label">${l}:</span> <span class="p-badge-value">${v}</span></span>`).join('');

    // Metrics
    const fmtE = r.E_facility < 0.001 ? (r.E_facility * 1e6).toFixed(1) + ' µWh' : (r.E_facility * 1000).toFixed(3) + ' Wh';
    const fmtC = r.C_q < 0.01 ? (r.C_q * 1000).toFixed(2) + ' mg CO₂e' : r.C_q.toFixed(4) + ' g CO₂e';
    const fmtW = r.W_q_ml < 1 ? r.W_q_ml.toFixed(3) + ' mL' : r.W_q_ml.toFixed(1) + ' mL';

    document.getElementById('prompt-metrics').innerHTML = `
        <div class="pm-card pm-energy">
            <div class="pm-icon">⚡</div>
            <div class="pm-label">Energy (facility)</div>
            <div class="pm-value" style="color:var(--energy-color)">${fmtE}</div>
            <div class="pm-sub">${(r.phoneCharges * 100).toFixed(3)}% of a phone charge</div>
        </div>
        <div class="pm-card pm-carbon">
            <div class="pm-icon">🌿</div>
            <div class="pm-label">Carbon</div>
            <div class="pm-value" style="color:var(--carbon-color)">${fmtC}</div>
            <div class="pm-sub">${r.drivingMeters.toFixed(2)} meters of driving</div>
        </div>
        <div class="pm-card pm-water">
            <div class="pm-icon">💧</div>
            <div class="pm-label">Water</div>
            <div class="pm-value" style="color:var(--water-color)">${fmtW}</div>
            <div class="pm-sub">${r.waterCups.toFixed(4)} cups</div>
        </div>
    `;

    // Formula transparency
    document.getElementById('prompt-formula').innerHTML = `
        <div><span class="pf-var">E_server</span>   = α_m × β_ℓ × γ_h = ${cfg.alpha_m.toExponential(2)} × ${r.beta_l.toFixed(2)} × 1.0 = <span class="pf-val">${r.E_server.toExponential(3)} kWh</span></div>
        <div><span class="pf-var">E_facility</span> = E_server × PUE = ${r.E_server.toExponential(3)} × ${PROMPT_INFRA.pue} = <span class="pf-val">${r.E_facility.toExponential(3)} kWh</span></div>
        <div><span class="pf-var">C_q</span>        = E_facility × I_grid = ${r.E_facility.toExponential(3)} × ${region.carbon} = <span class="pf-val">${r.C_q.toFixed(4)} g CO₂e</span></div>
        <div><span class="pf-var">W_q</span>        = E_server × ρ_s1 + E_facility × ρ_s2 = ${r.E_server.toExponential(3)} × ${PROMPT_INFRA.rho_s1} + ${r.E_facility.toExponential(3)} × ${PROMPT_INFRA.rho_s2} = <span class="pf-val">${r.W_q_ml.toFixed(3)} mL</span></div>
        <div style="margin-top:0.5rem;font-size:0.68rem;color:var(--text-muted)">α_m measured via CodeCarbon on Kaggle T4 · β_ℓ from keyword heuristics (R²=0.817) · PUE, ρ_s1, ρ_s2 from Li et al. (2023)</div>
    `;

    // Attributions
    const attrEl = document.getElementById('prompt-attr-list');
    if (!attrs.length) {
        attrEl.innerHTML = '<p class="attr-empty">No significant phrase-level variation detected. Try a longer prompt with explicit instructions like "in detail" or "with examples".</p>';
    } else {
        const maxDelta = Math.max(...attrs.map(a => Math.abs(a.deltaCarbon)));
        attrEl.innerHTML = attrs.map(a => {
            const isPos = a.deltaCarbon > 0;
            const pct = Math.min(100, (Math.abs(a.deltaCarbon) / maxDelta) * 100);
            const short = a.phrase.length > 55 ? a.phrase.slice(0, 55) + '…' : a.phrase;
            return `<div class="attr-row">
                <div style="flex:1">
                    <span class="attr-phrase">"${short}"</span>
                    <div class="attr-bar ${isPos ? 'cost-up' : 'cost-down'}" style="width:${pct}%"></div>
                </div>
                <span class="attr-delta ${isPos ? 'pos' : 'neg'}">${isPos ? '+' : ''}${a.deltaCarbon.toFixed(4)} g</span>
            </div>`;
        }).join('');
    }

    // Suggestions
    document.getElementById('prompt-sugg-list').innerHTML = suggs.map(s =>
        `<div class="sugg-item ${s.savings > 0 ? 'sugg-warn' : 'sugg-ok'}">
            <span class="sugg-icon">${s.icon}</span>
            <span>${s.text}${s.savings > 0 ? `<span class="sugg-savings">(~${s.savings}% savings)</span>` : ''}</span>
        </div>`
    ).join('');

    // Comparison bars: this prompt vs reference prompts
    const shortResult = computePromptFootprint('What is 2+2? Answer in one word.', modelKey, regionKey);
    const longResult = computePromptFootprint('Explain in detail how this works with multiple examples and step by step reasoning and comprehensive analysis.', modelKey, regionKey);
    const maxCarbon = Math.max(r.C_q, shortResult.C_q, longResult.C_q) * 1.1;

    document.getElementById('prompt-comparison-bars').innerHTML = [
        { label: 'Short prompt', val: shortResult.C_q, color: '#16a34a' },
        { label: 'Your prompt', val: r.C_q, color: '#2563eb' },
        { label: 'Very long prompt', val: longResult.C_q, color: '#dc2626' },
    ].map(item => {
        const pct = Math.max(2, (item.val / maxCarbon) * 100);
        return `<div class="comp-row">
            <span class="comp-label">${item.label}</span>
            <div class="comp-bar-bg">
                <div class="comp-bar-fill" style="width:${pct}%;background:${item.color}">
                    <span>${item.val.toFixed(4)}g</span>
                </div>
            </div>
        </div>`;
    }).join('');

    // Scroll to results
    document.getElementById('prompt-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}