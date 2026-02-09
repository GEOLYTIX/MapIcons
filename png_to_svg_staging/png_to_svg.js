const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const LOGO_DIR = './'; 
const PIN_BACKGROUND = '../pins/pink_master_pin.svg'; 
const CONFIG_FILE = 'configuration.json';
const GITHUB_BASE_URL = 'https://geolytix.github.io/MapIcons/brands_2024/';

// DIMENSIONS & SCALING
const VIEWBOX_SIZE = 24;      
const SCALE = 10;
const PROCESS_CANVAS = VIEWBOX_SIZE * SCALE; // 240px

// --- GEOMETRY SETTINGS ---
// Maximize usage of the pin head (Bulb).
const MAX_WIDTH = 18 * SCALE;  // 180px 
const MAX_HEIGHT = 14 * SCALE; // 140px 
const HEAD_CENTER_X = 12 * SCALE; // 120px
const HEAD_CENTER_Y = 9 * SCALE;  // 90px

// --- CONFIGURATION OBJECT ---
const configOutput = {
    "style": {
        "theme": {
            "title": "THEME",
            "field": "field",
            "type": "categorized",
            "distribution": "count",
            "cat": {}
        }
    }
};

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
            .tile { background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; }
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
        <h1>Map Pin Audit (Double Trim + Config Gen)</h1>
        <div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, 'svgs', outputName);
        const cleanName = path.parse(file).name; // e.g. "AkzoNobel" from "AkzoNobel.png"

        try {
            process.stdout.write(`Processing ${file}... `);
            const { hexColor, method, contrastColor } = await convertLogo(inputPath, outputPath);
            console.log(`✅ [${method}]`);
            
            // --- ADD TO CONFIGURATION ---
            // Format the key name (e.g. Title Case or keep original)
            // Using the filename as the key
            
            // Determine Pin Color: Use contrast color (background) or calculated opposite
            const pinColor = contrastColor || "#D9DBDA"; // Fallback grey

            configOutput.style.theme.cat[cleanName] = {
                "field": "retailer",
                "style": {
                    "icon": [
                        {
                            "type": "template",
                            "template": "template_pin",
                            "substitute": {
                                "#FF69B4": pinColor // The background pin color
                            },
                            "legendScale": 0.6
                        },
                        {
                            "svg": `${GITHUB_BASE_URL}${outputName}`
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
                        <div class="box-24">
                            <img src="${outputName}" width="24" height="24" style="position:relative; z-index:2;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Map Context</span>
                        <div class="box-24" style="background:transparent; border:none;"> 
                            <svg class="pin-bg" width="24" height="24" viewBox="0 0 24 24" fill="${pinColor}">
                                <path d="M 18.219 16.551 C 19.896 14.836 21.02 12.588 21.02 10.02 C 21.02 5.042 16.978 1 12 1 C 7.022 1 2.98 5.042 2.98 10.02 C 2.98 12.62 4.007 14.787 5.844 16.61 L 5.844 16.61 L 11.633 23 L 18.23 16.551 L 18.219 16.551 Z" />
                            </svg>
                            <img src="${outputName}" width="24" height="24" class="pin-fg">
                        </div>
                    </div>
                </div>
                <div class="footer">
                    <span>${method}</span>
                    <span><span class="color-chip" style="background:${hexColor}"></span>${hexColor}</span>
                </div>
            </div>`;
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }
    
    // WRITE AUDIT HTML
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    
    // WRITE CONFIG JSON
    fs.writeFileSync(path.join(LOGO_DIR, CONFIG_FILE), JSON.stringify(configOutput, null, 2));

    console.log(`\n👉 Open ${path.join(LOGO_DIR, 'audit.html')} to verify.`);
    console.log(`👉 Config generated: ${path.join(LOGO_DIR, CONFIG_FILE)}`);
}

async function convertLogo(inputPath, outputPath) {
    // 1. SMART EXTRACTION (Double Trim)
    const analysis = await extractAndTrim(inputPath);
    const { maskBuffer, fillColor, method, contrastColor } = analysis;

    // 2. RESIZE (MAXIMIZE)
    const resizedMask = await sharp(maskBuffer)
        .resize({
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            fit: 'contain', 
            background: { r:255, g:255, b:255, alpha:1 } 
        })
        .png() 
        .toBuffer();

    // 3. CENTER
    const { info: maskInfo } = await sharp(resizedMask).toBuffer({ resolveWithObject: true });
    
    const left = Math.round(HEAD_CENTER_X - (maskInfo.width / 2));
    const top = Math.round(HEAD_CENTER_Y - (maskInfo.height / 2));

    // 4. COMPOSITE
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

    // 5. TRACE
    const pathData = await traceBuffer(finalCanvas, fillColor);

    // 6. ASSEMBLE SVG
    const rawSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
            <g transform="scale(${1/SCALE})">
                <path d="${pathData}" fill="${fillColor}" fill-rule="evenodd" /> 
            </g>
        </svg>
    `;

    // 7. OPTIMIZE
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

    // Check if the output directory exists, if not create it
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    fs.writeFileSync(outputPath, result.data);
    return { hexColor: fillColor, method, contrastColor };
}

// --- INTELLIGENT "DOUBLE TRIM" MASKING ---
async function extractAndTrim(inputPath) {
    // STEP 1: Initial Trim (Peel Outer Layer)
    const trimmedInput = await sharp(inputPath)
        .trim({ threshold: 10 }) 
        .toBuffer();

    // Analyze the *Trimmed* image
    const { data, info } = await sharp(trimmedInput)
        .resize(800, 800, { fit: 'inside' }) 
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // Identify Background from the corners
    const corners = [0, info.width-1, info.width*(info.height-1), (info.width*info.height)-1];
    let bgR=0, bgG=0, bgB=0, bgCount=0;
    
    let transparentCount = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i+3] < 50) transparentCount++;
    }
    const isTransparent = transparentCount > (data.length / 4) * 0.1;

    if (!isTransparent) {
        corners.forEach(idx => {
            const i = idx * 4;
            bgR += data[i]; bgG += data[i+1]; bgB += data[i+2];
            bgCount++;
        });
        bgR = Math.round(bgR/bgCount); bgG = Math.round(bgG/bgCount); bgB = Math.round(bgB/bgCount);
    }

    // Determine Contrast Color (For the Pin Body)
    // If extraction is Transparent, use a default Grey.
    // If extraction is Box, use the Box Color (so the text sits on the original box color).
    let contrastColor = '#D9DBDA';
    if (!isTransparent) {
        contrastColor = '#' + [bgR, bgG, bgB].map(c => c.toString(16).padStart(2,'0')).join('');
    } else {
        // If transparent, we need to guess a contrast color. 
        // We'll calculate it later based on the Fill Color if needed, but for now default grey is safer.
        // Or we can try to find a complementary color.
    }

    // STEP 2: Masking
    const maskRaw = Buffer.alloc(info.width * info.height * 3);
    const fgPixels = [];

    for (let i = 0; i < info.width * info.height; i++) {
        const idx = i * 4;
        const outIdx = i * 3;
        
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        let isLogo = false;

        if (a < 100) {
            isLogo = false; 
        } else if (isTransparent) {
            isLogo = true;  
        } else {
            const dist = Math.sqrt(Math.pow(r-bgR,2) + Math.pow(g-bgG,2) + Math.pow(b-bgB,2));
            isLogo = dist > 45; 
        }

        if (isLogo) {
            maskRaw[outIdx] = 0; maskRaw[outIdx+1] = 0; maskRaw[outIdx+2] = 0;
            fgPixels.push({r, g, b});
        } else {
            maskRaw[outIdx] = 255; maskRaw[outIdx+1] = 255; maskRaw[outIdx+2] = 255;
        }
    }

    // Determine Fill Color
    let fillColor = '#000000';
    if (fgPixels.length > 0) {
        let r=0, g=0, b=0;
        fgPixels.forEach(p => { r+=p.r; g+=p.g; b+=p.b });
        const len = fgPixels.length;
        fillColor = '#' + [Math.round(r/len), Math.round(g/len), Math.round(b/len)]
            .map(c => c.toString(16).padStart(2,'0')).join('');
    }
    
    // Calculate Pin Contrast if Transparent
    if (isTransparent) {
        // If logo is dark, make pin light. If logo is light, make pin dark.
        const rgb = parseInt(fillColor.slice(1), 16);   // convert rrggbb to decimal
        const r = (rgb >> 16) & 0xff; 
        const g = (rgb >>  8) & 0xff;
        const b = (rgb >>  0) & 0xff;
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b; // per ITU-R BT.709
        contrastColor = luma < 128 ? '#f0f2f5' : '#333333';
    }

    // STEP 3: Second Trim (Zoom to Content)
    const finalMaskBuffer = await sharp(maskRaw, { raw: { width: info.width, height: info.height, channels: 3 } })
        .trim({ threshold: 10, background: {r:255, g:255, b:255} }) 
        .png()
        .toBuffer();

    return { 
        maskBuffer: finalMaskBuffer, 
        fillColor, 
        method: isTransparent ? 'Transparent Extract' : 'Box Drill-Down',
        contrastColor
    };
}

function traceBuffer(buffer, color) {
    return new Promise((resolve, reject) => {
        const params = {
            turdSize: 20, 
            optTolerance: 0.2,
            color: color 
        };
        
        potrace.trace(buffer, params, (err, svg) => {
            if (err) return reject(err);
            const dMatch = svg.match(/d="([^"]+)"/);
            resolve(dMatch ? dMatch[1] : '');
        });
    });
}

processAllLogos();