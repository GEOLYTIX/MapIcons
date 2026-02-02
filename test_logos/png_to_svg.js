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

// --- SMART HEAD TARGETING ---
// The "Head" of a standard pin is a circle at the top. 
// We define a constraint box that fits safely inside that upper circle.
const MAX_WIDTH = 20 * SCALE;  // 200px (Leaves 20px side padding total)
const MAX_HEIGHT = 14 * SCALE; // 140px (Restricts height to avoid tail)

// PIN HEAD CENTER Y
// The visual center of the round part is usually around y=9 or 10, not y=12.
const HEAD_CENTER_Y = 9.5 * SCALE; 

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
            .box-24 { width: 24px; height: 24px; margin: 0 auto; position: relative; }
            .border-red { border: 1px solid red; background: white; }
            
            /* Guide: The 20x14 box positioned at y=9.5 */
            .border-guide { 
                position: absolute; 
                left: 50%; 
                top: ${(HEAD_CENTER_Y / SCALE)}px; /* 9.5px */
                transform: translate(-50%, -50%);
                width: 20px; height: 14px; 
                border: 1px dotted #00c853; 
                pointer-events: none; box-sizing: border-box; 
            }
            
            .pin-bg { position: absolute; top: 0; left: 0; z-index: 1; }
            .pin-fg { position: absolute; top: 0; left: 0; z-index: 2; }
            .color-chip { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; border:1px solid #ccc; }
        </style>
    </head>
    <body>
        <h1>Map Pin Audit (Head-Targeted Fit)</h1>
        <div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            process.stdout.write(`Processing ${file}... `);
            const hexColor = await convertLogo(inputPath, outputPath);
            console.log(`✅`);
            
            htmlContent += `
            <div class="tile">
                <div class="tile-header" title="${file}">${file}</div>
                <div class="tile-body">
                    <div>
                        <span class="label">Original</span>
                        <img src="${file}" height="24" style="object-fit: contain;">
                    </div>
                    <div>
                        <span class="label">Smart Fit</span>
                        <div class="box-24 border-red">
                            <div class="border-guide"></div>
                            <img src="${outputName}" width="24" height="24" style="position:relative; z-index:1;">
                        </div>
                    </div>
                    <div>
                        <span class="label">Map View</span>
                        <div class="box-24">
                            <img src="${PIN_BACKGROUND}" width="24" height="24" class="pin-bg">
                            <img src="${outputName}" width="24" height="24" class="pin-fg">
                        </div>
                    </div>
                </div>
                <div style="text-align:center; padding:5px; font-size:10px; color:#666; background:#fafafa; border-top:1px solid #eee;">
                    <span class="color-chip" style="background:${hexColor}"></span>${hexColor}
                </div>
            </div>`;
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n👉 Open ${path.join(LOGO_DIR, 'audit.html')} to verify.`);
}

async function convertLogo(inputPath, outputPath) {
    // 1. ANALYZE COLORS & BACKGROUND
    const { fgColorHex, bgColorObj } = await analyzeImageColors(inputPath);

    // 2. ISOLATE TEXT (High-Res Mask)
    // Returns black text on transparent background (500x500 normalized)
    const isolatedBuffer = await createTraceMask(inputPath, bgColorObj);

    // 3. SMART RESIZE (Fit to 200x140 Box)
    // - Wide logos -> Width 200, Height < 140
    // - Square/Tall logos -> Height 140, Width < 200
    const resizedLogo = await sharp(isolatedBuffer)
        .resize(MAX_WIDTH, MAX_HEIGHT, { 
            fit: 'contain', 
            background: { r:0, g:0, b:0, alpha:0 } 
        })
        .toBuffer();

    // 4. CALCULATE HEAD PLACEMENT
    const { info: logoInfo } = await sharp(resizedLogo).toBuffer({ resolveWithObject: true });

    // Horizontal Center: (240 - Width) / 2
    const left = Math.round((PROCESS_CANVAS - logoInfo.width) / 2);
    
    // Vertical Head Placement:
    // We want the CENTER of the logo to be at HEAD_CENTER_Y (95px).
    // Top = TargetCenter - (Height / 2)
    const top = Math.round(HEAD_CENTER_Y - (logoInfo.height / 2));

    // 5. COMPOSITE ONTO CANVAS
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
        top: Math.max(0, top), // Safety clamp
        left: Math.max(0, left)
    }])
    .ensureAlpha()
    .raw()
    .toBuffer();

    // 6. TRACE
    const pathData = await traceBuffer(finalCanvas, PROCESS_CANVAS, PROCESS_CANVAS, fgColorHex);

    // 7. ASSEMBLE SVG
    const rawSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
            <g transform="scale(${1/SCALE})">
                <path d="${pathData}" fill="${fgColorHex}" fill-rule="evenodd" /> 
            </g>
        </svg>
    `;

    // 8. OPTIMIZE
    const result = optimize(rawSvg, {
        multipass: true,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: { convertPathData: { floatPrecision: 2 }, collapseGroups: false }
                }
            },
            'moveGroupAttrsToElems',
            'collapseGroups',
            { name: 'removeViewBox', active: false }
        ]
    });

    fs.writeFileSync(outputPath, result.data);
    return fgColorHex;
}

// --- HELPERS ---

async function analyzeImageColors(inputPath) {
    const { data, info } = await sharp(inputPath)
        .resize(100, 100, { fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const corners = [0, info.width - 1, info.width * (info.height - 1), (info.width * info.height) - 1];
    let rSum=0, gSum=0, bSum=0, count=0;
    corners.forEach(idx => {
        const i = idx * 4;
        if (data[i+3] > 200) { rSum += data[i]; gSum += data[i+1]; bSum += data[i+2]; count++; }
    });

    const hasBoxBg = count > 2;
    const bgR = hasBoxBg ? Math.round(rSum/count) : 255;
    const bgG = hasBoxBg ? Math.round(gSum/count) : 255;
    const bgB = hasBoxBg ? Math.round(bSum/count) : 255;
    
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 4) {
        if (data[i+3] < 128) continue;
        const dist = Math.sqrt(Math.pow(data[i]-bgR, 2) + Math.pow(data[i+1]-bgG, 2) + Math.pow(data[i+2]-bgB, 2));
        if (dist > 45) {
            const hex = `#${((1 << 24) + (data[i] << 16) + (data[i+1] << 8) + data[i+2]).toString(16).slice(1)}`;
            colorCounts[hex] = (colorCounts[hex] || 0) + 1;
        }
    }
    const sorted = Object.keys(colorCounts).sort((a,b) => colorCounts[b] - colorCounts[a]);
    return { fgColorHex: sorted[0] || '#000000', bgColorObj: hasBoxBg ? { r: bgR, g: bgG, b: bgB } : null };
}

async function createTraceMask(inputPath, bgColorObj) {
    // 1. Normalize Size (High Res)
    const { data, info } = await sharp(inputPath)
        .resize(500, 500, { fit: 'inside' }) 
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const output = Buffer.alloc(data.length);
    for (let i = 0; i < info.width * info.height; i++) {
        const idx = i * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        let shouldTrace = false;

        if (a < 128) shouldTrace = false;
        else if (bgColorObj) {
            const dist = Math.sqrt(Math.pow(r-bgColorObj.r, 2) + Math.pow(g-bgColorObj.g, 2) + Math.pow(b-bgColorObj.b, 2));
            shouldTrace = dist > 40; 
        } else shouldTrace = true;

        const val = shouldTrace ? 0 : 255;
        output[idx] = val; output[idx+1] = val; output[idx+2] = val; output[idx+3] = 255; 
    }
    // Return PNG Buffer for Sharp Composite
    return sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
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