const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const LOGO_DIR = './'; 
const PIN_BACKGROUND = '../pins/pink_master_pin.svg'; 

// DIMENSIONS & SCALING
const VIEWBOX_SIZE = 24;      
const SCALE = 10;
const PROCESS_CANVAS = VIEWBOX_SIZE * SCALE; // 240px

// --- AGGRESSIVE HEAD TARGETING ---
const MAX_WIDTH = 22 * SCALE;  // 220px
const MAX_HEIGHT = 16 * SCALE; // 160px
const HEAD_CENTER_Y = 10 * SCALE; 

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return console.log(`❌ Directory ${LOGO_DIR} not found.`);
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file));
    
    let htmlContent = `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #f0f2f5; padding: 20px; }
            h1 { text-align: center; color: #333; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
            .tile { background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); overflow: hidden; }
            .tile-header { background: #007bff; color: white; padding: 10px; font-size: 13px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tile-body { padding: 15px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; text-align: center; }
            .label { display: block; font-size: 10px; color: #666; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
            
            /* Updated: Grey background for previews so WHITE logos are visible */
            .box-24 { width: 24px; height: 24px; margin: 0 auto; position: relative; background: #cccccc; border-radius: 4px; }
            .box-24.original { background: white; } /* Keep original on white */
            
            .border-red { border: 1px solid red; }
            .border-guide { 
                position: absolute; left: 50%; top: ${(HEAD_CENTER_Y / SCALE)}px; 
                transform: translate(-50%, -50%); width: 22px; height: 16px; 
                border: 1px dotted #00c853; pointer-events: none; box-sizing: border-box; 
            }
            .pin-bg { position: absolute; top: 0; left: 0; z-index: 1; }
            .pin-fg { position: absolute; top: 0; left: 0; z-index: 2; }
            .color-chip { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; border:1px solid #ccc; vertical-align:middle; }
            .footer { text-align:center; padding:5px; font-size:10px; color:#666; background:#fafafa; border-top:1px solid #eee; }
        </style>
    </head>
    <body>
        <h1>Map Pin Audit (White Text Fix)</h1>
        <div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            process.stdout.write(`Processing ${file}... `);
            const { hexColor, method } = await convertLogo(inputPath, outputPath);
            console.log(`✅ [${method}]`);
            
            htmlContent += `
            <div class="tile">
                <div class="tile-header" title="${file}">${file}</div>
                <div class="tile-body">
                    <div>
                        <span class="label">Original</span>
                        <div class="box-24 original">
                            <img src="${file}" height="24" style="object-fit: contain;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Max Fill (Grey BG)</span>
                        <div class="box-24 border-red">
                            <div class="border-guide"></div>
                            <img src="${outputName}" width="24" height="24" style="position:relative; z-index:1;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Map View</span>
                        <div class="box-24" style="background:white"> <img src="${PIN_BACKGROUND}" width="24" height="24" class="pin-bg">
                            <img src="${outputName}" width="24" height="24" class="pin-fg">
                        </div>
                    </div>
                </div>
                <div class="footer">
                    ${method} <span class="color-chip" style="background:${hexColor}"></span>${hexColor}
                </div>
            </div>`;
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n👉 Open ${path.join(LOGO_DIR, 'audit.html')} to verify. (Previews have grey backgrounds to show white logos).`);
}

async function convertLogo(inputPath, outputPath) {
    // 1. ANALYZE & PREPROCESS
    const analysis = await analyzeAndIsolate(inputPath);
    const { maskBuffer, fillColor } = analysis;

    // 2. RESIZE (MAXIMIZE SPACE)
    const resizedLogo = await sharp(maskBuffer)
        .resize(MAX_WIDTH, MAX_HEIGHT, { 
            fit: 'contain', 
            background: { r:0, g:0, b:0, alpha:0 } 
        })
        .toBuffer();

    // 3. CENTER IN HEAD
    const { info: logoInfo } = await sharp(resizedLogo).toBuffer({ resolveWithObject: true });
    const left = Math.round((PROCESS_CANVAS - logoInfo.width) / 2);
    const top = Math.round(HEAD_CENTER_Y - (logoInfo.height / 2));

    // 4. COMPOSITE
    const finalCanvas = await sharp({
        create: {
            width: PROCESS_CANVAS,
            height: PROCESS_CANVAS,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0 }
        }
    })
    .composite([{ 
        input: resizedLogo, 
        top: Math.max(0, top), 
        left: Math.max(0, left)
    }])
    .ensureAlpha()
    .raw()
    .toBuffer();

    // 5. TRACE
    const pathData = await traceBuffer(finalCanvas, PROCESS_CANVAS, PROCESS_CANVAS, fillColor);

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
                params: { overrides: { convertPathData: { floatPrecision: 2 }, collapseGroups: false } }
            },
            'moveGroupAttrsToElems',
            'collapseGroups',
            { name: 'removeViewBox', active: false }
        ]
    });

    fs.writeFileSync(outputPath, result.data);
    return { hexColor: fillColor, method: analysis.method };
}

// --- HELPER: INTELLIGENT ANALYSIS ---
async function analyzeAndIsolate(inputPath) {
    const { data, info } = await sharp(inputPath)
        .resize(500, 500, { fit: 'inside' }) 
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // 1. Detect Background (Corners)
    const corners = [0, info.width - 1, info.width * (info.height - 1), (info.width * info.height) - 1];
    let rSum=0, gSum=0, bSum=0, count=0;
    corners.forEach(idx => {
        const i = idx * 4;
        if (data[i+3] > 200) { rSum += data[i]; gSum += data[i+1]; bSum += data[i+2]; count++; }
    });

    const isBoxLogo = count > 2; 
    const bgR = isBoxLogo ? Math.round(rSum/count) : 0;
    const bgG = isBoxLogo ? Math.round(gSum/count) : 0;
    const bgB = isBoxLogo ? Math.round(bSum/count) : 0;

    // 2. Determine Fill Color & Method
    let fillColor = '#000000';
    let method = 'Standard';

    if (!isBoxLogo) {
        // Standard Transparent BG
        fillColor = getDominantColor(data, null);
        method = 'Transparent BG';
    } else {
        // BOX LOGO DETECTED
        // FIX: Always extract the foreground color, regardless of box brightness.
        // We tell getDominantColor to ignore the background box color.
        fillColor = getDominantColor(data, { r: bgR, g: bgG, b: bgB });
        method = 'Box Text Extraction'; 
    }

    // 3. Create Mask
    const output = Buffer.alloc(data.length);
    for (let i = 0; i < info.width * info.height; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        let shouldTrace = false;

        if (a < 128) {
            shouldTrace = false; 
        } else if (isBoxLogo) {
            // Trace if pixel differs significantly from Background Box color
            const dist = Math.sqrt(Math.pow(r-bgR, 2) + Math.pow(g-bgG, 2) + Math.pow(b-bgB, 2));
            shouldTrace = dist > 45; 
        } else {
            shouldTrace = true;
        }

        const val = shouldTrace ? 0 : 255;
        output[idx] = val; output[idx+1] = val; output[idx+2] = val; output[idx+3] = 255; 
    }

    const maskBuffer = await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer();

    return { maskBuffer, fillColor, method };
}

function getDominantColor(data, ignoreColor) {
    const counts = {};
    for (let i = 0; i < data.length; i += 4) {
        if (data[i+3] < 128) continue;
        
        const r = data[i], g = data[i+1], b = data[i+2];
        
        if (ignoreColor) {
            const dist = Math.sqrt(Math.pow(r-ignoreColor.r, 2) + Math.pow(g-ignoreColor.g, 2) + Math.pow(b-ignoreColor.b, 2));
            if (dist < 45) continue; // Skip background pixels
        }

        const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        counts[hex] = (counts[hex] || 0) + 1;
    }
    const sorted = Object.keys(counts).sort((a,b) => counts[b] - counts[a]);
    // If we filtered everything out (e.g. solid box with no distinct text), fallback to black
    return sorted[0] || '#000000';
}

function traceBuffer(buffer, width, height, color) {
    return new Promise(async (resolve) => {
        const tempFile = path.join(LOGO_DIR, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
        await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(tempFile);

        potrace.trace(tempFile, { turdSize: 1, optTolerance: 0.2, color }, (err, svg) => {
            try { fs.unlinkSync(tempFile); } catch(e){}
            if (err) return resolve('');
            const dMatch = svg.match(/d="([^"]+)"/);
            return resolve(dMatch ? dMatch[1] : '');
        });
    });
}

processAllLogos();