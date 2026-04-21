/**
 * AI Footprint Calculator — app.js
 * Estimation engine, Chart.js visualizations, UI interactions
 *
 * Methodology:
 *   E_facility = α_m × β_l × γ_h × PUE               [kWh/query]
 *   C_q        = E_facility × I_grid                   [gCO₂e/query]
 *   W_q        = E_facility × (WUE + EWIF) × 1000     [mL/query]
 *
 * Sources (12+ peer-reviewed & official):
 *   [1] Luccioni, Jernite & Strubell (2023/2024) — "Power Hungry Processing" (ACM FAccT)
 *   [2] Li, Yang, Islam & Ren (2023) — "Making AI Less Thirsty" (arXiv:2304.03271)
 *   [3] Dodge et al. (2022) — "Measuring Carbon Intensity of AI" (ACM FAccT)
 *   [4] Patterson et al. (2021) — "Carbon Emissions of Large NNs" (arXiv:2104.10350)
 *   [5] Patterson et al. (2022) — "ML Carbon Footprint Will Plateau" (IEEE Computer)
 *   [6] IEA (2025/2026) — Data Centre Energy Demand Report
 *   [7] Google (Aug 2025) — Gemini energy disclosure: median text = 0.24 Wh
 *   [8] OpenAI / Sam Altman (Jun 2025) — ChatGPT energy: avg = 0.34 Wh
 *   [9] Epoch AI (2025) — Inference energy analysis: median ~0.3 Wh
 *   [10] Uptime Institute (2025) — Global PUE survey: avg = 1.56
 *   [11] CEA India (FY2024-25) — CO₂ Baseline: 710 gCO₂/MWh
 *   [12] Ember (2025) — Global Electricity Review: EU 213, US 384 gCO₂/kWh
 *   [13] EcoLogits (2024) — Bottom-up LCA methodology for GenAI inference
 */

'use strict';

/* ──────────── CALIBRATION PARAMETERS ──────────── */

const PARAMS = {
    models: {
        small:  { name: 'Small LLM (<7B)',    energy: { min: 0.0001,  avg: 0.00024, max: 0.0005  } },
        medium: { name: 'Medium LLM (7–70B)', energy: { min: 0.0003,  avg: 0.0007,  max: 0.002   } },
        large:  { name: 'Large LLM (>70B)',   energy: { min: 0.001,   avg: 0.003,   max: 0.010   } },
        image:  { name: 'Image Generation',   energy: { min: 0.003,   avg: 0.015,   max: 0.050   } },
    },
    promptLength: {
        short:    { label: 'Short (<50 tokens)',        factor: 0.70 },
        medium:   { label: 'Medium (50–200 tokens)',    factor: 1.00 },
        long:     { label: 'Long (200–500 tokens)',     factor: 1.50 },
        verylong: { label: 'Very Long (500+ tokens)',   factor: 2.50 },
    },
    hardware: {
        efficient: { label: 'Modern/Efficient', factor: 0.70 },
        average:   { label: 'Average',          factor: 1.00 },
        older:     { label: 'Older Hardware',   factor: 1.40 },
    },
    regions: {
        renewable: { name: 'Renewable-heavy', carbon: { min: 20,  avg: 50,  max: 100 } },
        eu:        { name: 'EU Average',      carbon: { min: 150, avg: 213, max: 300 } },
        us:        { name: 'US Average',      carbon: { min: 300, avg: 384, max: 450 } },
        india:     { name: 'India',           carbon: { min: 650, avg: 710, max: 800 } },
        coal:      { name: 'Coal-heavy',      carbon: { min: 750, avg: 850, max: 950 } },
    },
    pue: { min: 1.10, avg: 1.30, max: 1.58 },
    water: {
        onsite: { min: 0.00, avg: 0.50, max: 1.80 },
        ewif:   { min: 1.00, avg: 2.80, max: 5.50 },
    },
};

const CASE_STUDIES = {
    student: {
        label: 'Student', queries: 40, model: 'medium',
        prompt: 'medium', hw: 'average', region: 'india',
    },
    pro: {
        label: 'Professional', queries: 200, model: 'large',
        prompt: 'long', hw: 'average', region: 'us',
    },
    heavy: {
        label: 'Heavy/Researcher', queries: 500, model: 'large',
        prompt: 'long', hw: 'efficient', region: 'us',
    },
};

/* Awareness facts that rotate in the "Did you know?" callout */
const AWARENESS_FACTS = [
    "A single image generation query uses as much energy as charging your smartphone <strong>1.5 times</strong>. Text queries use up to 60× less energy.",
    "Data centers globally consumed <strong>415 TWh</strong> in 2024 — more than many entire countries. AI is the fastest-growing segment.",
    "Choosing a provider on a renewable grid can reduce your carbon footprint by <strong>14×</strong> compared to a coal-heavy grid.",
    "Google's AI efficiency improved <strong>33× in 12 months</strong> (2024→2025). The same query today costs a fraction of what it did a year ago.",
    "A ChatGPT query uses <strong>~0.34 Wh</strong> — about the same as keeping an LED bulb on for 2 minutes.",
    "Very long reasoning prompts (chain-of-thought) can use <strong>10–70× more tokens</strong> internally than the visible output.",
    "The average global PUE for data centers has been stuck at <strong>~1.56 for 6 years</strong> — only hyperscalers like Google achieve ~1.09.",
    "India's power grid emits <strong>710 gCO₂/kWh</strong> (FY2024-25), making AI usage in India particularly carbon-intensive.",
];

/* ──────────── STATE ──────────── */

let timeHorizon = 'monthly';
let charts = {};
let currentFactIndex = 0;

/* ──────────── CORE CALCULATION ──────────── */

function calculate(modelKey, queries, promptKey, hwKey, regionKey) {
    const m = PARAMS.models[modelKey];
    const β = PARAMS.promptLength[promptKey].factor;
    const γ = PARAMS.hardware[hwKey].factor;
    const r = PARAMS.regions[regionKey];

    // Per-query calculations (min/avg/max)
    const perQuery = {};
    ['min', 'avg', 'max'].forEach(level => {
        const pueLevel = level;
        const eServer  = m.energy[level] * β * γ;
        const eFacility = eServer * PARAMS.pue[pueLevel];
        const carbon   = eFacility * r.carbon[level];
        const waterL   = eFacility * (PARAMS.water.onsite[level] + PARAMS.water.ewif[level]);
        const waterML  = waterL * 1000;
        perQuery[level] = { energy: eFacility, carbon, water: waterML, waterL };
    });

    // Cumulative projections
    const cumulative = {};
    const periods = { daily: 1, monthly: 30, yearly: 365 };
    Object.entries(periods).forEach(([period, days]) => {
        cumulative[period] = {};
        ['min', 'avg', 'max'].forEach(level => {
            const n = queries * days;
            cumulative[period][level] = {
                energy: perQuery[level].energy * n,
                carbon: perQuery[level].carbon * n,
                water:  perQuery[level].waterL * n,  // in litres
            };
        });
    });

    // Monthly projection (12 months)
    const monthly = [];
    for (let i = 1; i <= 12; i++) {
        monthly.push({
            min: perQuery.min.carbon * queries * 30 * i,
            avg: perQuery.avg.carbon * queries * 30 * i,
            max: perQuery.max.carbon * queries * 30 * i,
        });
    }

    return { perQuery, cumulative, monthly };
}

/* ──────────── FORMATTING ──────────── */

function fmt(value) {
    if (value === 0) return '0';
    if (Math.abs(value) >= 10000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (Math.abs(value) >= 100)   return value.toFixed(1);
    if (Math.abs(value) >= 1)     return value.toFixed(2);
    if (Math.abs(value) >= 0.01)  return value.toFixed(3);
    if (Math.abs(value) >= 0.001) return value.toFixed(4);
    return value.toExponential(2);
}
function fmtRange(val) {
    if (Math.abs(val) >= 100) return val.toFixed(0);
    if (Math.abs(val) >= 1) return val.toFixed(1);
    return val.toFixed(2);
}

/* ──────────── SEVERITY ──────────── */

function getSeverity(carbonPerQuery) {
    if (carbonPerQuery < 0.5) return 'low';
    if (carbonPerQuery < 5)   return 'med';
    return 'high';
}

function getSeverityPercent(value, metricType) {
    // Returns 0-100 based on where value falls in the possible range
    const ranges = {
        energy: { min: 0.00007, max: 0.2 },  // kWh
        carbon: { min: 0.001,   max: 100 },    // gCO₂e
        water:  { min: 0.07,    max: 500 },    // mL
    };
    const r = ranges[metricType];
    const logVal = Math.log10(Math.max(value, r.min));
    const logMin = Math.log10(r.min);
    const logMax = Math.log10(r.max);
    return Math.min(100, Math.max(5, ((logVal - logMin) / (logMax - logMin)) * 100));
}

/* ──────────── IMPACT STATEMENT GENERATOR ──────────── */

function generateImpactStatement(results) {
    const carbon = results.perQuery.avg.carbon;
    const energy = results.perQuery.avg.energy;
    const severity = getSeverity(carbon);

    // Update carbon value with severity coloring
    const el = document.getElementById('impact-carbon-val');
    el.textContent = fmt(carbon);
    el.className = 'impact-carbon severity-' + severity;

    // Generate relatable equivalent
    const carMeters = (carbon / 192) * 1000; // gCO₂ / (gCO₂/km) * 1000 = meters
    const phoneCharges = energy / 0.01;
    const ledMinutes = (energy * 1000 / 10) * 60; // kWh -> Wh / 10W * 60min

    let equivText = '';
    if (carMeters >= 1000) {
        equivText = `driving ${fmt(carMeters / 1000)} km by car`;
    } else if (carMeters >= 1) {
        equivText = `driving ${Math.round(carMeters)} meters by car`;
    } else if (ledMinutes >= 1) {
        equivText = `keeping an LED bulb on for ${fmtRange(ledMinutes)} minutes`;
    } else {
        equivText = `${fmtRange(phoneCharges * 100)}% of a smartphone charge`;
    }

    document.getElementById('impact-equiv-text').textContent = equivText;
    document.getElementById('impact-range').textContent =
        `Range: ${fmt(results.perQuery.min.carbon)} – ${fmt(results.perQuery.max.carbon)} gCO₂e`;
}

/* ──────────── UI UPDATES ──────────── */

function updateMetricCards(results) {
    const pq = results.perQuery;
    const severity = getSeverity(pq.avg.carbon);

    // Energy card
    document.getElementById('energy-avg').textContent = fmt(pq.avg.energy);
    document.getElementById('energy-min').textContent = fmt(pq.min.energy);
    document.getElementById('energy-max').textContent = fmt(pq.max.energy);
    const energyBar = document.getElementById('energy-bar');
    energyBar.style.width = getSeverityPercent(pq.avg.energy, 'energy') + '%';
    energyBar.className = 'severity-fill sev-' + severity;

    // Carbon card
    document.getElementById('carbon-avg').textContent = fmt(pq.avg.carbon);
    document.getElementById('carbon-min').textContent = fmt(pq.min.carbon);
    document.getElementById('carbon-max').textContent = fmt(pq.max.carbon);
    const carbonBar = document.getElementById('carbon-bar');
    carbonBar.style.width = getSeverityPercent(pq.avg.carbon, 'carbon') + '%';
    carbonBar.className = 'severity-fill sev-' + severity;

    // Water card
    document.getElementById('water-avg').textContent = fmt(pq.avg.water);
    document.getElementById('water-min').textContent = fmt(pq.min.water);
    document.getElementById('water-max').textContent = fmt(pq.max.water);
    const waterBar = document.getElementById('water-bar');
    waterBar.style.width = getSeverityPercent(pq.avg.water, 'water') + '%';
    waterBar.className = 'severity-fill sev-' + severity;

    // Pop animation
    document.querySelectorAll('.metric-avg').forEach(el => {
        el.classList.remove('pop');
        void el.offsetWidth; // trigger reflow
        el.classList.add('pop');
    });
}

function updateCumulative(results) {
    const cumul = results.cumulative[timeHorizon];
    document.getElementById('cumul-energy').textContent = fmt(cumul.avg.energy);
    document.getElementById('cumul-carbon').textContent = fmt(cumul.avg.carbon);
    document.getElementById('cumul-water').textContent = fmt(cumul.avg.water);
    document.getElementById('period-label').textContent =
        { daily: 'Daily', monthly: 'Monthly', yearly: 'Yearly' }[timeHorizon];
}

function updateEquivalents(results) {
    const cumul = results.cumulative[timeHorizon];
    const periodName = { daily: 'daily', monthly: 'monthly', yearly: 'yearly' }[timeHorizon];
    const equivPeriodEl = document.getElementById('equiv-period');
    if (equivPeriodEl) equivPeriodEl.textContent = periodName;

    // Phone charges
    const phones = Math.round(cumul.avg.energy / 0.01);
    document.getElementById('eq-phone').textContent = phones.toLocaleString();

    // Car km
    const carKm = cumul.avg.carbon / 192;
    document.getElementById('eq-car').textContent = fmt(carKm);

    // Water bottles
    const bottles = Math.round(cumul.avg.water / 0.5);
    document.getElementById('eq-water').textContent = bottles.toLocaleString();

    // Trees (yearly)
    const yearlyCarbon = results.cumulative.yearly.avg.carbon;
    const trees = yearlyCarbon / 21000;
    document.getElementById('eq-tree').textContent = trees < 0.01 ? trees.toExponential(2) : fmtRange(trees);

    // Google searches
    const searches = Math.round(cumul.avg.energy / 0.0003);
    document.getElementById('eq-search').textContent = searches.toLocaleString();

    // Household %
    const yearlyEnergy = results.cumulative.yearly.avg.energy;
    const housePct = (yearlyEnergy / 3500) * 100;
    document.getElementById('eq-house').textContent = housePct < 0.01
        ? housePct.toExponential(2) + '%'
        : fmtRange(housePct) + '%';
}

/* ──────────── CHARTS ──────────── */

const chartFont = { family: "'Inter', sans-serif", size: 11, weight: '500' };
const chartFontSmall = { ...chartFont, size: 10 };
const gridColor = 'rgba(0, 0, 0, 0.05)';
const tickColor = '#6b9a70';

function buildComparisonChart(results) {
    const ctx = document.getElementById('comparisonChart');
    if (!ctx) return;

    const cumul = results.cumulative[timeHorizon];
    const phones = Math.round(cumul.avg.energy / 0.01);
    const searches = Math.round(cumul.avg.energy / 0.0003);
    const carKm = cumul.avg.carbon / 192;
    const bottles = Math.round(cumul.avg.water / 0.5);

    const data = {
        labels: ['📱 Phone charges', '🔍 Google searches', '🚗 km driven', '💧 Water bottles'],
        datasets: [{
            data: [phones, searches, carKm, bottles],
            backgroundColor: [
                'rgba(250, 204, 21, 0.65)',
                'rgba(96, 165, 250, 0.65)',
                'rgba(248, 113, 113, 0.65)',
                'rgba(45, 212, 191, 0.65)',
            ],
            borderColor: [
                'rgba(250, 204, 21, 1)',
                'rgba(96, 165, 250, 1)',
                'rgba(248, 113, 113, 1)',
                'rgba(45, 212, 191, 1)',
            ],
            borderWidth: 1.5,
            borderRadius: 6,
        }],
    };

    if (charts.comparison) {
        charts.comparison.data = data;
        charts.comparison.update('none');
        return;
    }

    charts.comparison = new Chart(ctx, {
        type: 'bar',
        data,
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'white',
                    titleColor: '#1a2e1c',
                    bodyColor: '#3d6b42',
                    titleFont: chartFont,
                    bodyFont: chartFontSmall,
                    borderColor: 'rgba(34,120,60,0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 12,
                },
            },
            scales: {
                x: {
                    grid: { color: gridColor },
                    ticks: { color: tickColor, font: chartFontSmall },
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#16a34a', font: { ...chartFont, size: 12 } },
                },
            },
        },
    });
}

function buildCumulativeChart(results) {
    const ctx = document.getElementById('cumulativeChart');
    if (!ctx) return;

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const data = {
        labels: months,
        datasets: [
            {
                label: 'Max',
                data: results.monthly.map(m => m.max),
                borderColor: 'rgba(220, 38, 38, 0.35)',
                backgroundColor: 'rgba(220, 38, 38, 0.06)',
                fill: '+1', pointRadius: 0, borderWidth: 1, borderDash: [4, 3],
            },
            {
                label: 'Average',
                data: results.monthly.map(m => m.avg),
                borderColor: '#16a34a',
                backgroundColor: 'rgba(22, 163, 74, 0.08)',
                fill: false, pointRadius: 4, pointBackgroundColor: '#16a34a',
                borderWidth: 2.5, tension: 0.1,
            },
            {
                label: 'Min',
                data: results.monthly.map(m => m.min),
                borderColor: 'rgba(13, 148, 136, 0.35)',
                backgroundColor: 'rgba(13, 148, 136, 0.06)',
                fill: '-1', pointRadius: 0, borderWidth: 1, borderDash: [4, 3],
            },
        ],
    };

    if (charts.cumulative) {
        charts.cumulative.data = data;
        charts.cumulative.update('none');
        return;
    }

    charts.cumulative = new Chart(ctx, {
        type: 'line',
        data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#16a34a', font: chartFontSmall, usePointStyle: true, pointStyleWidth: 8 },
                },
                tooltip: {
                    backgroundColor: 'white',
                    titleColor: '#1a2e1c',
                    bodyColor: '#3d6b42',
                    titleFont: chartFont,
                    bodyFont: chartFontSmall,
                    borderColor: 'rgba(34,120,60,0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 12,
                    callbacks: {
                        label: ctx2 => `${ctx2.dataset.label}: ${fmt(ctx2.parsed.y)} gCO₂e`,
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: gridColor },
                    ticks: { color: tickColor, font: chartFontSmall },
                },
                y: {
                    grid: { color: gridColor },
                    ticks: {
                        color: tickColor,
                        font: chartFontSmall,
                        callback: v => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(1),
                    },
                    title: { display: true, text: 'Cumulative gCO₂e', color: tickColor, font: chartFontSmall },
                },
            },
        },
    });
}

/* ──────────── SENSITIVITY ANALYSIS ──────────── */

function buildSensitivityChart(results) {
    const ctx = document.getElementById('sensitivityChart');
    if (!ctx) return;

    const baseline = results.perQuery.avg.carbon;

    // Compute range for each factor
    const factors = [
        {
            label: 'Model Type',
            min: calculate('small', 1, 'medium', 'average', 'india').perQuery.avg.carbon,
            max: calculate('image', 1, 'medium', 'average', 'india').perQuery.avg.carbon,
        },
        {
            label: 'Grid / Region',
            min: calculate('medium', 1, 'medium', 'average', 'renewable').perQuery.avg.carbon,
            max: calculate('medium', 1, 'medium', 'average', 'coal').perQuery.avg.carbon,
        },
        {
            label: 'Prompt Length',
            min: calculate('medium', 1, 'short', 'average', 'india').perQuery.avg.carbon,
            max: calculate('medium', 1, 'verylong', 'average', 'india').perQuery.avg.carbon,
        },
        {
            label: 'PUE Range',
            min: (() => { const r = calculate('medium', 1, 'medium', 'average', 'india'); return r.perQuery.min.carbon * PARAMS.pue.min / PARAMS.pue.avg; })(),
            max: (() => { const r = calculate('medium', 1, 'medium', 'average', 'india'); return r.perQuery.max.carbon * PARAMS.pue.max / PARAMS.pue.avg; })(),
        },
        {
            label: 'Hardware',
            min: calculate('medium', 1, 'medium', 'efficient', 'india').perQuery.avg.carbon,
            max: calculate('medium', 1, 'medium', 'older', 'india').perQuery.avg.carbon,
        },
    ];

    const spreads = factors.map(f => ((f.max - f.min) / baseline) * 100);

    // Sort by impact
    const sorted = factors.map((f, i) => ({ ...f, spread: spreads[i] }))
                         .sort((a, b) => b.spread - a.spread);

    // Update insight text
    const topFactor = sorted[0].label.toLowerCase();
    document.getElementById('sensitivity-insight').textContent =
        `💡 ${sorted[0].label} has the largest impact — switching can change your footprint by up to ${Math.round(sorted[0].spread)}%. Focus here first.`;

    const colors = [
        'rgba(220, 38, 38, 0.65)',
        'rgba(22, 163, 74, 0.65)',
        'rgba(234, 88, 12, 0.65)',
        'rgba(37, 99, 235, 0.65)',
        'rgba(202, 138, 4, 0.65)',
    ];

    const data = {
        labels: sorted.map(s => s.label),
        datasets: [{
            data: sorted.map(s => s.spread),
            backgroundColor: colors,
            borderColor: colors.map(c => c.replace('0.85', '1')),
            borderWidth: 1.5, borderRadius: 6,
        }],
    };

    if (charts.sensitivity) {
        charts.sensitivity.data = data;
        charts.sensitivity.update('none');
        return;
    }

    charts.sensitivity = new Chart(ctx, {
        type: 'bar',
        data,
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: c => `±${Math.round(c.parsed.x)}% spread` },
                    backgroundColor: 'white',
                    titleColor: '#1a2e1c',
                    bodyColor: '#3d6b42',
                    titleFont: chartFont,
                    bodyFont: chartFontSmall,
                    borderColor: 'rgba(34,120,60,0.2)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 12,
                },
            },
            scales: {
                x: {
                    grid: { color: gridColor },
                    ticks: {
                        color: tickColor, font: chartFontSmall,
                        callback: v => v + '%',
                    },
                    title: { display: true, text: 'Relative spread in avg carbon estimate (%)', color: tickColor, font: chartFontSmall },
                },
                y: {
                    grid: { display: false },
                    ticks: { color: '#16a34a', font: chartFont },
                },
            },
        },
    });
}

/* ──────────── CASE STUDIES ──────────── */

function updateCaseStudies() {
    const profiles = ['student', 'pro', 'heavy'];
    const csResults = {};

    profiles.forEach(key => {
        const p = CASE_STUDIES[key];
        csResults[key] = calculate(p.model, p.queries, p.prompt, p.hw, p.region);
    });

    // Compute real-world equivalents for each profile
    profiles.forEach(key => {
        const r = csResults[key];
        const cumul = r.cumulative.monthly;

        // Phone charges/mo
        const phones = Math.round(cumul.avg.energy / 0.01);
        document.getElementById(`cs-${key}-phone`).textContent = phones.toLocaleString();

        // km driven/mo
        const km = cumul.avg.carbon / 192;
        document.getElementById(`cs-${key}-car`).textContent = fmt(km);

        // Water bottles/mo
        const bottles = Math.round(cumul.avg.water / 0.5);
        document.getElementById(`cs-${key}-bottles`).textContent = bottles.toLocaleString();

        // Trees to offset/yr
        const yearlyCarbon = r.cumulative.yearly.avg.carbon;
        const trees = yearlyCarbon / 21000;
        document.getElementById(`cs-${key}-trees`).textContent = fmtRange(trees);
    });

    // Generate punchy taglines
    const studentKm = csResults.student.cumulative.monthly.avg.carbon / 192;
    const proKm = csResults.pro.cumulative.monthly.avg.carbon / 192;
    const heavyKm = csResults.heavy.cumulative.monthly.avg.carbon / 192;
    const proYearlyTrees = csResults.pro.cumulative.yearly.avg.carbon / 21000;
    const heavyYearlyTrees = csResults.heavy.cumulative.yearly.avg.carbon / 21000;

    document.getElementById('cs-student-tagline').textContent =
        `"Like driving ${fmtRange(studentKm)} km per month — about a short trip to the grocery store."`;

    if (proKm >= 100) {
        document.getElementById('cs-pro-tagline').textContent =
            `"Like driving ${Math.round(proKm)} km per month. You'd need ${fmtRange(proYearlyTrees)} trees to offset a year of this."`;
    } else {
        document.getElementById('cs-pro-tagline').textContent =
            `"Like driving ${fmtRange(proKm)} km per month — requires ${fmtRange(proYearlyTrees)} trees to offset annually."`;
    }

    document.getElementById('cs-heavy-tagline').textContent =
        `"Like driving ${Math.round(heavyKm)} km per month — you'd need to plant ${Math.round(heavyYearlyTrees)} trees to go carbon-neutral."`;
}

/* ──────────── AWARENESS FACTS ROTATION ──────────── */

function showNextFact() {
    currentFactIndex = (currentFactIndex + 1) % AWARENESS_FACTS.length;
    const el = document.getElementById('callout-text');
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => {
        el.innerHTML = AWARENESS_FACTS[currentFactIndex];
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
    }, 250);
}

/* ──────────── MAIN RENDER ──────────── */

function render() {
    const model   = document.getElementById('model-type').value;
    const queries = parseInt(document.getElementById('queries-per-day').value, 10);
    const prompt  = document.getElementById('prompt-length').value;
    const hw      = document.getElementById('hardware').value;
    const region  = document.getElementById('region').value;

    const results = calculate(model, queries, prompt, hw, region);

    // Update all UI sections
    generateImpactStatement(results);
    updateMetricCards(results);
    updateCumulative(results);
    updateEquivalents(results);
    buildComparisonChart(results);
    buildCumulativeChart(results);
    buildSensitivityChart(results);
    updateCaseStudies();

    // Update chart period labels
    const periodName = { daily: 'daily', monthly: 'monthly', yearly: 'yearly' }[timeHorizon];
    const chartPeriod1 = document.getElementById('chart-period-1');
    if (chartPeriod1) chartPeriod1.textContent = periodName;
}

/* ──────────── EVENT LISTENERS ──────────── */

document.addEventListener('DOMContentLoaded', () => {
    // Input listeners
    ['model-type', 'prompt-length', 'hardware', 'region'].forEach(id => {
        document.getElementById(id).addEventListener('change', render);
    });

    const slider = document.getElementById('queries-per-day');
    const display = document.getElementById('queries-display');
    slider.addEventListener('input', () => {
        display.textContent = slider.value;
        render();
    });

    // Time horizon buttons
    document.querySelectorAll('.btn-option').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-option').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            timeHorizon = btn.dataset.value;
            render();
        });
    });

    // Did you know? next button
    const nextBtn = document.getElementById('callout-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', showNextFact);

    // Auto-rotate facts every 10 seconds
    setInterval(showNextFact, 10000);

    // Tooltip system
    setupTooltips();

    // Add transition to callout text
    const calloutText = document.getElementById('callout-text');
    if (calloutText) {
        calloutText.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
    }

    // Ctrl+Enter shortcut for prompt analysis
    const promptTextarea = document.getElementById('user-prompt');
    if (promptTextarea) {
        promptTextarea.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); analyzePrompt(); }
        });
    }

    // Initial render
    render();
});

/* ──────────── TOOLTIP SYSTEM ──────────── */

function setupTooltips() {
    const popup = document.getElementById('tooltip-popup');
    document.querySelectorAll('.tooltip-icon').forEach(icon => {
        const text = icon.getAttribute('data-tooltip');
        if (!text) return;

        const show = () => {
            popup.textContent = text;
            popup.classList.add('visible');
            const rect = icon.getBoundingClientRect();
            popup.style.left = Math.min(rect.left, window.innerWidth - 290) + 'px';
            popup.style.top  = (rect.bottom + 8) + 'px';
        };
        const hide = () => popup.classList.remove('visible');

        icon.addEventListener('mouseenter', show);
        icon.addEventListener('mouseleave', hide);
        icon.addEventListener('focus',      show);
        icon.addEventListener('blur',       hide);
    });
}

/* ================================================================
   PROMPT-LEVEL ANALYSIS ENGINE
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

    // Comparison bars: this prompt vs reference prompts — CONSISTENT LAYOUT
    const shortResult = computePromptFootprint('What is 2+2? Answer in one word.', modelKey, regionKey);
    const longResult = computePromptFootprint('Explain in detail how this works with multiple examples and step by step reasoning and comprehensive analysis.', modelKey, regionKey);
    const maxCarbon = Math.max(r.C_q, shortResult.C_q, longResult.C_q) * 1.1;

    document.getElementById('prompt-comparison-bars').innerHTML = [
        { label: 'Short prompt', val: shortResult.C_q, color: '#16a34a' },
        { label: 'Your prompt', val: r.C_q, color: '#2563eb' },
        { label: 'Very long prompt', val: longResult.C_q, color: '#dc2626' },
    ].map(item => {
        const pct = Math.max(2, (item.val / maxCarbon) * 100);
        // Always show text outside the bar for consistency
        return `<div class="comp-row">
            <span class="comp-label">${item.label}</span>
            <div class="comp-bar-bg">
                <div class="comp-bar-fill" style="width:${pct}%;background:${item.color}"></div>
                <span class="comp-val">${item.val.toFixed(4)} g</span>
            </div>
        </div>`;
    }).join('');

    // Scroll to results
    document.getElementById('prompt-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
