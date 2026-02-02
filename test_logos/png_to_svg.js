const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

// CONFIGURATION
const LOGO_DIR = './';
const VIEWBOX_SIZE = 24;     // Final SVG ViewBox (24x24)
const SAFE_SIZE = 20;        // Max content size (20x20)
const SCALE = 10;            // Processing multiplier (10x)

// Calculated constants
const PROCESS_CANVAS = VIEWBOX_SIZE * SCALE; // 240px
const PROCESS_SAFE = SAFE_SIZE * SCALE;      // 200px

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return console.log(`❌ Directory ${LOGO_DIR} not found.`);
    
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file));
    
    let htmlContent = `<html><body style="background:#eee;font-family:sans-serif;padding:20px;">
        <h1>Safe Zone Audit (20px in 24px)</h1>
        <p>Red Box = 24px ViewBox (Pin Size)<br>Green Box = 20px Safe Zone (Logo Limit)</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:15px;">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            process.stdout.write(`Processing ${file}... `);
            await convertLogo(inputPath, outputPath);
            console.log(`✅`);
            
            htmlContent += `
            <div style="background:white;padding:15px;border-radius:8px;text-align:center;">
                <div style="margin-bottom:10px;font-weight:bold;font-size:12px;overflow:hidden;text-overflow:ellipsis;">${file}</div>
                <div style="display:flex; justify-content:center; gap:20px; align-items:center;">
                    <div style="opacity:0.6;"><img src="${file}" height="40" style="object-fit:contain"></div>
                    <div>→</div>
                    <div style="position:relative; width:24px; height:24px; border:1px solid red; background:white; margin:0 auto;">
                        <div style="position:absolute; top:2px; left:2px; width:20px; height:20px; border:1px dotted green; pointer-events:none; box-sizing:border-box;"></div>
                        <img src="${outputName}" width="24" height="24">
                    </div>
                </div>
            </div>`;
        } catch (err) {
            console.log(`❌ Error: ${err.message}`);
        }
    }
    
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n👉 Check ${path.join(LOGO_DIR, 'audit.html')} to verify limits.`);
}

async function convertLogo(inputPath, outputPath) {
    // 1. RESIZE CONTENT (Force into 200x200 box)
    const resizedContent = await sharp(inputPath)
        .resize(PROCESS_SAFE, PROCESS_SAFE, { 
            fit: 'contain', 
            background: { r: 0, g: 0, b: 0, alpha: 0 } 
        })
        .toFormat('png')
        .toBuffer();

    // 2. DETECT BACKGROUND (Box Killer)
    // Analyze resized content for a solid background box
    const { data: contentData, info: contentInfo } = await sharp(resizedContent)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // Check corners of the CONTENT (0,0)
    let bgColorToRemove = null;
    const r = contentData[0], g = contentData[1], b = contentData[2], a = contentData[3];
    
    // If corner is solid (Alpha > 200), we assume it's a box logo
    if (a > 200) {
        bgColorToRemove = { r, g, b };
    }

    // 3. CREATE CANVAS & CENTER (Add Padding)
    // Composite 200px content into 240px transparent canvas
    const fullCanvas = await sharp({
        create: {
            width: PROCESS_CANVAS,
            height: PROCESS_CANVAS,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0 }
        }
    })
    .composite([{ input: resizedContent, gravity: 'center' }])
    .png()
    .toBuffer();

    // 4. TRACE MASK GENERATION
    const { data, info } = await sharp(fullCanvas).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const mask = Buffer.alloc(info.width * info.height * 4);

    let foundPixels = false;

    for (let i = 0; i < info.width * info.height; i++) {
        const idx = i * 4;
        const pr = data[idx], pg = data[idx+1], pb = data[idx+2], pa = data[idx+3];

        let shouldTrace = false;

        if (pa < 128) {
            shouldTrace = false; // Transparent
        } else if (bgColorToRemove) {
            // BOX LOGO LOGIC: Trace if pixel differs from box color
            const dist = Math.sqrt(
                Math.pow(pr - bgColorToRemove.r, 2) + 
                Math.pow(pg - bgColorToRemove.g, 2) + 
                Math.pow(pb - bgColorToRemove.b, 2)
            );
            shouldTrace = dist > 40; 
        } else {
            // STANDARD LOGIC: Trace if opaque
            shouldTrace = true;
        }

        // Potrace: Black (0) = Trace, White (255) = Ignore
        const val = shouldTrace ? 0 : 255;
        mask[idx] = mask[idx+1] = mask[idx+2] = val;
        mask[idx+3] = 255; 
        
        if (shouldTrace) foundPixels = true;
    }

    // Fallback: If we stripped everything, revert to tracing all opaque pixels
    if (!foundPixels && bgColorToRemove) {
        for (let i = 0; i < info.width * info.height; i++) {
            const idx = i * 4;
            const val = (data[idx+3] > 128) ? 0 : 255;
            mask[idx] = mask[idx+1] = mask[idx+2] = val;
        }
    }

    // 5. PERFORM TRACE
    const pathData = await traceBuffer(mask, info.width, info.height, '#000000');

    // 6. ASSEMBLE & OPTIMIZE (FIXED SVGO CONFIG)
    const rawSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
            <g transform="scale(${1/SCALE})">
                <path d="${pathData}" fill="black" /> 
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
                        // REMOVED 'removeViewBox' from here to fix the error
                        convertPathData: { floatPrecision: 2 },
                        collapseGroups: false // Keep disabled inside preset, handle outside
                    }
                }
            },
            // PLUGINS OUTSIDE PRESET:
            'moveGroupAttrsToElems',
            'collapseGroups',
            {
                name: 'removeViewBox',
                active: false // Explicitly disable removing viewBox
            }
        ]
    });

    fs.writeFileSync(outputPath, result.data);
}

function traceBuffer(buffer, width, height, color) {
    return new Promise(async (resolve) => {
        const tempFile = path.join(LOGO_DIR, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
        await sharp(buffer, { raw: { width, height, channels: 4 } }).png().toFile(tempFile);

        potrace.trace(tempFile, { turdSize: 20, optTolerance: 0.4, color }, (err, svg) => {
            try { fs.unlinkSync(tempFile); } catch(e){}
            if (err) return resolve('');
            const dMatch = svg.match(/d="([^"]+)"/);
            return resolve(dMatch ? dMatch[1] : '');
        });
    });
}

processAllLogos();