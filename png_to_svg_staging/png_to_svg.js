const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const LOGO_DIR = './'; 
const GITHUB_BASE_URL = 'https://geolytix.github.io/MapIcons/mapp_logos/';
const LOGOS_FILE = 'logos.json';
const FASCIA_FILE = 'logos_fascia_open_close.json';

// DIMENSIONS & SCALING
const VIEWBOX_SIZE = 24;      
const SCALE = 10;
const PROCESS_CANVAS = VIEWBOX_SIZE * SCALE; // 240px

// --- GEOMETRY SETTINGS ---
const MAX_WIDTH = 18 * SCALE;  // 180px 
const MAX_HEIGHT = 14 * SCALE; // 140px 
const HEAD_CENTER_X = 12 * SCALE; // 120px
const HEAD_CENTER_Y = 9 * SCALE;  // 90px

// --- CONFIGURATION OBJECTS ---
const logosConfig = {
    "style": {
        "themes": {
            "logos": {
                "type": "categorized",
                "distribution": "count",
                "cat": {}
            }
        }
    }
};

const fasciaConfig = {
    "style": {
        "themes": {
            "logos_fascia_open_close": {
                "type": "categorized",
                "distribution": "count",
                "fields": [
                    "open_close",
                    "fascia"
                ],
                "cat": {}
            }
        }
    }
};

// Helper function to format brand names
function formatBrandName(name) {
    return name.replace(/[_-]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return console.log(`❌ Directory ${LOGO_DIR} not found.`);
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file));
    
    let htmlContent = `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #e0e0e0; padding: 20px; }
            h1 { text-align: center; color: #333; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
            .tile { background: aliceblue; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; }
            .tile-header { background: #333; color: white; padding: 10px; font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tile-body { padding: 15px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; text-align: center; align-items: end; }
            .label { display: block; font-size: 10px; color: #666; margin-bottom: 5px; text-transform: uppercase; font-weight:bold; }
            .box-24 { width: 24px; height: 24px; margin: 0 auto; position: relative; background: #ccc; border-radius: 4px; border: 1px solid #999; }
            .box-24.original { background: white; border-color: #eee; }
            .pin-bg { position: absolute; top: 0; left: 0; z-index: 1; }
            .pin-fg { position: absolute; top: 0; left: 0; z-index: 10; }
            .footer { text-align:center; padding:8px; font-size:11px; color:#555; background:#f9f9f9; border-top:1px solid #eee; display:flex; justify-content:space-between; align-items:center; }
            .color-chip { width:12px; height:12px; border-radius:50%; border:1px solid rgba(0,0,0,0.2); display:inline-block; vertical-align:middle; margin-right:4px; }
        </style>
    </head>
    <body>
        <h1>Map Pin Audit (White SVG on Colored Pin)</h1>
        <div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, 'svgs', outputName);
        const cleanName = path.parse(file).name; 
        const brandName = formatBrandName(cleanName);

        try {
            process.stdout.write(`Processing ${file}... `);
            const { prominentColor, method } = await convertLogo(inputPath, outputPath);
            console.log(`✅ [${method}]`);
            
            const pinColor = prominentColor;

            // 1. Populate logos.json
            logosConfig.style.themes.logos.cat[brandName] = {
                "style": {
                    "icon": [
                        {
                            "type": "template",
                            "template": "template_pin",
                            "substitute": {
                                "#FF69B4": pinColor
                            },
                            "legendScale": 0.7
                        },
                        {
                            "svg": `${GITHUB_BASE_URL}${outputName}`
                        }
                    ]
                }
            };

            // 2. Populate logos_fascia_open_close.json
            fasciaConfig.style.themes.logos_fascia_open_close.cat[brandName] = {
                "field": "fascia",
                "style": {
                    "icon": [
                        {
                            "type": "template",
                            "template": "master_pin_foreground",
                            "substitute": {
                                "#FF69B4": pinColor
                            },
                            "legendScale": 0.7
                        },
                        {
                            "svg": `${GITHUB_BASE_URL}${outputName}`,
                            "legendScale": 0.7
                        }
                    ]
                }
            };

            htmlContent += `
            <div class="tile">
                <div class="tile-header" title="${file}">${file}</div>
                <div class="tile-body">
                    <div>
                        <span class="label">Original</span>
                        <div class="box-24 original">
                            <img src="${file}" height="24" style="max-width:24px; object-fit: contain;">
                        </div>
                    </div>
                    <div>
                        <span class="label">SVG Result</span>
                        <div class="box-24" style="background:#333;">
                            <img src="svgs/${outputName}" width="24" height="24" style="position:relative; z-index:2;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Map Context</span>
                        <div class="box-24" style="background:transparent; border:none;"> 
                            <svg class="pin-bg" width="24" height="24" viewBox="0 0 24 24" fill="${pinColor}">
                                <path d="M 18.219 16.551 C 19.896 14.836 21.02 12.588 21.02 10.02 C 21.02 5.042 16.978 1 12 1 C 7.022 1 2.98 5.042 2.98 10.02 C 2.98 12.62 4.007 14.787 5.844 16.61 L 5.844 16.61 L 11.633 23 L 18.23 16.551 L 18.219 16.551 Z" />
                            </svg>
                            <img src="svgs/${outputName}" width="24" height="24" class="pin-fg">
                        </div>
                    </div>
                </div>
                <div class="footer">
                    <span>${method}</span>
                    <span><span class="color-chip" style="background:${pinColor}"></span>${pinColor}</span>
                </div>
            </div>`;
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    
    // Write both JSON files
    fs.writeFileSync(path.join(LOGO_DIR, LOGOS_FILE), JSON.stringify(logosConfig, null, 2));
    fs.writeFileSync(path.join(LOGO_DIR, FASCIA_FILE), JSON.stringify(fasciaConfig, null, 2));

    console.log(`\n👉 Open ${path.join(LOGO_DIR, 'audit.html')} to verify.`);
    console.log(`👉 Config generated: ${path.join(LOGO_DIR, LOGOS_FILE)}`);
    console.log(`👉 Config generated: ${path.join(LOGO_DIR, FASCIA_FILE)}`);
}

async function convertLogo(inputPath, outputPath) {
    const analysis = await extractAndTrim(inputPath);
    const { maskBuffer, prominentColor, method } = analysis;

    const resizedMask = await sharp(maskBuffer)
        .resize({
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            fit: 'contain', 
            background: { r:255, g:255, b:255, alpha:1 } 
        })
        .png() 
        .toBuffer();

    const { info: maskInfo } = await sharp(resizedMask).toBuffer({ resolveWithObject: true });
    
    const left = Math.round(HEAD_CENTER_X - (maskInfo.width / 2));
    const top = Math.round(HEAD_CENTER_Y - (maskInfo.height / 2));

    const finalCanvas = await sharp({
        create: {
            width: PROCESS_CANVAS,
            height: PROCESS_CANVAS,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    })
    .composite([{ 
        input: resizedMask, 
        top: Math.max(0, top), 
        left: Math.max(0, left)
    }])
    .png()
    .toBuffer();

    const pathData = await traceBuffer(finalCanvas);

    // Hardcode the extracted shape to pure white. 
    // The mask ensures backgrounds were dropped.
    const rawSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
            <g transform="scale(${1/SCALE})">
                <path d="${pathData}" fill="#FFFFFF" fill-rule="evenodd" /> 
            </g>
        </svg>
    `;

    const result = optimize(rawSvg, {
        multipass: true,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        convertPathData: { floatPrecision: 2 }
                    }
                }
            }
        ]
    });

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(outputPath, result.data);
    return { prominentColor, method };
}

// --- INTELLIGENT EXTRACTION ENGINE ---
//
// Background is removed by flood-filling inward from the border: starting
// from every edge pixel, flood-fill through neighbours that are either both
// transparent or close in colour to their neighbour. This strips anything
// connected to the frame's edge - a real transparent margin, a checkerboard
// artifact baked into the pixels by an export tool, or a solid fill shape
// (e.g. a circle/rectangle background) that touches the border - regardless
// of its colour, without needing to guess a single "the" background colour
// upfront. Everything left over (not border-connected, and opaque) is the
// logo content and is kept.
const BORDER_FLOOD_TOLERANCE = 40;
// Comparing neighbours alone lets the fill creep up a soft anti-aliased edge
// (white -> pink -> red in steps smaller than the tolerance) and then swallow
// the whole letter. So every flooded pixel must also stay within this distance
// of the border pixel its fill started from.
const BORDER_ROOT_TOLERANCE = 100;
// An opaque border region is only treated as a background fill if it encloses
// at least this share of the image in other opaque content. Letters that touch
// the image edge enclose only transparent counters (or a thin anti-aliased
// fringe), so they are kept.
const ENCLOSED_CONTENT_MIN_SHARE = 0.005;

async function extractAndTrim(inputPath) {
    // 1. No initial trim: sharp's trim crops away a solid fill margin (e.g. text
    // on an opaque navy square), leaving the logo touching every edge so the
    // fill is no longer recognised as background. The mask is trimmed in step 5.
    //
    // Cap the working resolution at 800px on the long edge, but never enlarge a
    // smaller source: upscaling introduces smooth interpolated gradients between
    // colours (e.g. a sharp orange/white edge spread over several pixels), and
    // those gentle gradients let the border flood-fill below leak through edges
    // it should stop at.
    const { data, info } = await sharp(inputPath)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const total = width * height;

    // 2a. Pass 1: flood-fill each region connected to the border separately
    const compOf = new Int32Array(total).fill(-1);
    const queue = new Int32Array(total);
    const comps = []; // { root, size }

    const isTransparentPx = (idx) => data[idx * 4 + 3] < 100;
    const colourDist = (idxA, idxB) => {
        const pa = idxA * 4, pb = idxB * 4;
        const dr = data[pa] - data[pb], dg = data[pa+1] - data[pb+1], db = data[pa+2] - data[pb+2];
        return Math.sqrt(dr*dr + dg*dg + db*db);
    };
    const closeEnough = (idxA, idxB, root) => {
        const aTransparent = isTransparentPx(idxA);
        const bTransparent = isTransparentPx(idxB);
        if (aTransparent || bTransparent) return aTransparent && bTransparent;
        return colourDist(idxA, idxB) < BORDER_FLOOD_TOLERANCE && colourDist(root, idxB) < BORDER_ROOT_TOLERANCE;
    };
    const forEachNeighbour = (idx, fn) => {
        const x = idx % width, y = (idx / width) | 0;
        if (x > 0) fn(idx - 1);
        if (x < width - 1) fn(idx + 1);
        if (y > 0) fn(idx - width);
        if (y < height - 1) fn(idx + width);
    };

    const borderIdx = [];
    for (let x = 0; x < width; x++) borderIdx.push(x, (height - 1) * width + x);
    for (let y = 0; y < height; y++) borderIdx.push(y * width, y * width + (width - 1));

    for (const root of borderIdx) {
        if (compOf[root] !== -1) continue;
        const id = comps.length;
        let qTail = 0;
        compOf[root] = id;
        queue[qTail++] = root;
        for (let qHead = 0; qHead < qTail; qHead++) {
            const idx = queue[qHead];
            forEachNeighbour(idx, n => {
                if (compOf[n] === -1 && closeEnough(idx, n, root)) {
                    compOf[n] = id;
                    queue[qTail++] = n;
                }
            });
        }
        comps.push({ root, size: qTail });
    }

    // 2b. Pass 2: decide which border regions are background. Transparent
    // regions always are. An opaque region touching the border may instead be
    // part of the logo itself (e.g. a letter on a tightly cropped image), so it
    // only counts as background when it encloses other opaque content - a fill
    // shape sitting behind the logo. Regions are checked largest first so that
    // enclosed pixels matching an already-accepted background colour (e.g. the
    // white counter of a letter on a white JPG) don't count as content.
    const borderBg = new Uint8Array(total);
    const bgRoots = [];
    const acceptBg = (id) => {
        bgRoots.push(comps[id].root);
        for (let i = 0; i < total; i++) if (compOf[i] === id) borderBg[i] = 1;
    };
    const enclosesContent = (id) => {
        const outside = new Uint8Array(total);
        let qTail = 0;
        for (const idx of borderIdx) {
            if (compOf[idx] !== id && !outside[idx]) { outside[idx] = 1; queue[qTail++] = idx; }
        }
        for (let qHead = 0; qHead < qTail; qHead++) {
            forEachNeighbour(queue[qHead], n => {
                if (compOf[n] !== id && !outside[n]) { outside[n] = 1; queue[qTail++] = n; }
            });
        }
        let enclosed = 0;
        for (let i = 0; i < total; i++) {
            if (outside[i] || compOf[i] === id || isTransparentPx(i)) continue;
            // Transparent roots carry meaningless RGB, so only compare opaque fills.
            if (bgRoots.some(r => !isTransparentPx(r) && colourDist(r, i) < BORDER_ROOT_TOLERANCE)) continue;
            enclosed++;
        }
        return enclosed >= total * ENCLOSED_CONTENT_MIN_SHARE;
    };

    const compIds = comps.map((_, id) => id);
    compIds.filter(id => isTransparentPx(comps[id].root)).forEach(acceptBg);
    compIds
        .filter(id => !isTransparentPx(comps[id].root))
        .sort((a, b) => comps[b].size - comps[a].size)
        .forEach(id => { if (enclosesContent(id)) acceptBg(id); });

    // An opaque region holding an image corner is canvas (e.g. the white
    // corners around a round badge on a non-alpha PNG) even though it encloses
    // nothing, as is any other border region touching that canvas (e.g. a
    // corner cut off from the rest by a grey crop line along the top edge).
    // Removed, but kept out of bgRoots so its colour isn't treated as a fill -
    // the white artwork inside the badge would otherwise match it.
    const canvas = new Uint8Array(total);
    const isCandidate = id => !isTransparentPx(comps[id].root) && !borderBg[comps[id].root];
    const acceptCanvas = id => {
        for (let i = 0; i < total; i++) if (compOf[i] === id) { borderBg[i] = 1; canvas[i] = 1; }
    };
    new Set([0, width - 1, total - width, total - 1].map(i => compOf[i]))
        .forEach(id => { if (isCandidate(id)) acceptCanvas(id); });
    for (let changed = true; changed;) {
        changed = false;
        const touching = new Set();
        for (let i = 0; i < total; i++) {
            if (!canvas[i]) continue;
            forEachNeighbour(i, n => { if (!canvas[n]) touching.add(compOf[n]); });
        }
        touching.forEach(id => {
            if (id >= 0 && isCandidate(id)) { acceptCanvas(id); changed = true; }
        });
    }

    // 2c. Pass 3: regions not connected to the border. Once a fill colour is
    // known, any enclosed region of that colour is background too (e.g. the
    // inside of a ring or a letter's counter). An enclosed transparent region
    // mostly surrounded by fill is a knockout (artwork cut out of the fill),
    // so it becomes logo content.
    const fillRoots = bgRoots.filter(r => !isTransparentPx(r));
    const knockout = new Uint8Array(total);
    if (fillRoots.length) {
        for (let seed = 0; seed < total; seed++) {
            if (compOf[seed] !== -1) continue;
            const id = comps.length;
            let qTail = 0;
            compOf[seed] = id;
            queue[qTail++] = seed;
            for (let qHead = 0; qHead < qTail; qHead++) {
                const idx = queue[qHead];
                forEachNeighbour(idx, n => {
                    if (compOf[n] === -1 && closeEnough(idx, n, seed)) {
                        compOf[n] = id;
                        queue[qTail++] = n;
                    }
                });
            }
            comps.push({ root: seed, size: qTail });
            const members = queue.slice(0, qTail);
            if (!isTransparentPx(seed)) {
                if (fillRoots.some(r => colourDist(r, seed) < BORDER_ROOT_TOLERANCE)) {
                    members.forEach(i => { borderBg[i] = 1; });
                }
            } else {
                let bg = 0, fg = 0;
                members.forEach(i => forEachNeighbour(i, n => {
                    if (compOf[n] === id || isTransparentPx(n)) return;
                    if (borderBg[n]) bg++; else fg++;
                }));
                if (bg > fg) members.forEach(i => { knockout[i] = 1; });
            }
        }
    }

    const removed = borderBg.reduce((sum, v) => sum + v, 0);
    const detectionMethod = `Border flood (${((removed / total) * 100).toFixed(0)}% removed)`;

    // 3. Create Mask & Extract Foreground / Background Prominent Colours
    const maskRaw = Buffer.alloc(total * 3);
    const fgPixels = [];
    const bgPixels = [];

    for (let i = 0; i < total; i++) {
        const idx = i * 4;
        const outIdx = i * 3;

        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        const isLogo = (a >= 100 && !borderBg[i]) || knockout[i];

        if (isLogo) {
            maskRaw[outIdx] = 0; maskRaw[outIdx+1] = 0; maskRaw[outIdx+2] = 0; // Black keeps it for potrace
            fgPixels.push({r, g, b});
        } else {
            maskRaw[outIdx] = 255; maskRaw[outIdx+1] = 255; maskRaw[outIdx+2] = 255; // White drops it
            if (a >= 100) bgPixels.push({r, g, b}); // opaque background fill removed by the flood-fill
        }
    }

    // 4. Calculate Prominent Color for the pin: the single most common colour
    // among whatever opaque background fill was flooded away (the brand
    // colour), falling back to the most common kept foreground colour when
    // there was no fill (e.g. a plain multi-coloured icon on a fully
    // transparent canvas). The mode is used rather than a mean because a
    // removed background can include incidental artifact pixels (e.g. a
    // checkerboard placeholder pattern baked into the source image) whose
    // colour would otherwise dilute the true brand colour.
    //
    // The logo itself is drawn white on the pin, so a near-white pin is never
    // useful. When the removed background is plain white (e.g. a logo pasted
    // on a white square) the brand colour is the logo's own colour instead,
    // so take the most common non-white foreground colour.
    const isNearWhite = ({r, g, b}) => r >= 224 && g >= 224 && b >= 224;
    const modeColor = (pixels) => {
        const QUANT = 16;
        const histogram = new Map();
        for (const p of pixels) {
            const key = [p.r, p.g, p.b].map(c => Math.min(255, Math.round(c / QUANT) * QUANT)).join(',');
            histogram.set(key, (histogram.get(key) || 0) + 1);
        }
        let bestKey = null, bestCount = 0;
        for (const [key, count] of histogram) {
            if (count > bestCount) { bestCount = count; bestKey = key; }
        }
        if (!bestKey) return null;
        const [r, g, b] = bestKey.split(',').map(Number);
        return { r, g, b };
    };
    const toHex = ({r, g, b}) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

    let pinColor = modeColor(bgPixels);
    if (!pinColor || isNearWhite(pinColor)) {
        pinColor = modeColor(fgPixels.filter(p => !isNearWhite(p)));
    }
    const prominentColor = pinColor ? toHex(pinColor) : '#333333'; // fallback

    // 5. Second Trim (Zoom tightly to content shape)
    const finalMaskBuffer = await sharp(maskRaw, { raw: { width: info.width, height: info.height, channels: 3 } })
        .trim({ threshold: 10, background: {r:255, g:255, b:255} }) 
        .png()
        .toBuffer();

    return { 
        maskBuffer: finalMaskBuffer, 
        prominentColor, 
        method: detectionMethod
    };
}

function traceBuffer(buffer) {
    return new Promise((resolve, reject) => {
        potrace.trace(buffer, { turdSize: 20, optTolerance: 0.2 }, (err, svg) => {
            if (err) return reject(err);
            const dMatch = svg.match(/d="([^"]+)"/);
            resolve(dMatch ? dMatch[1] : '');
        });
    });
}

processAllLogos();