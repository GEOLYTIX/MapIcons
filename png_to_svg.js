const sharp = require('sharp');
const potrace = require('potrace');
const { optimize } = require('svgo');
const fs = require('fs');
const path = require('path');

const LOGO_DIR = './test_logos';

async function processAllLogos() {
    if (!fs.existsSync(LOGO_DIR)) return;
    const files = fs.readdirSync(LOGO_DIR).filter(file => /\.(png|jpg|jpeg)$/i.test(file));
    
    let htmlContent = `<html><head><style>
        body{font-family:sans-serif;background:#f4f4f4;padding:20px;}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;}
        .card{background:white;padding:15px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,0.1);}
        .comparison{display:flex;align-items:center;justify-content:space-between;margin-top:10px;background:#eee;padding:10px;border-radius:4px;}
        img,svg{width:64px;height:64px;object-fit:contain;background:#fff;border:1px solid #ddd;}
        .hex-chip{display:inline-block;width:10px;height:10px;margin-right:4px;border:1px solid #ccc;}
    </style></head><body><h1>Final Fixed Audit</h1><div class="grid">`;

    for (const file of files) {
        const inputPath = path.join(LOGO_DIR, file);
        const outputName = file.replace(/\.[^/.]+$/, "") + ".svg";
        const outputPath = path.join(LOGO_DIR, outputName);

        try {
            console.log(`Processing: ${file}...`);
            const colors = await convertToHighFidelity(inputPath, outputPath);
            
            htmlContent += `
            <div class="card">
                <strong>${file}</strong><br>
                <div style="margin-bottom:5px">${colors.map(c => `<span class="hex-chip" style="background:${c}"></span>`).join('')}</div>
                <div class="comparison">
                    <div><img src="${file}"><div class="label">Original</div></div>
                    <div><img src="${outputName}"><div class="label">Vector</div></div>
                </div>
            </div>`;
        } catch (err) {
            console.warn(`⚠️ Error ${file}: ${err.message}`);
        }
    }
    fs.writeFileSync(path.join(LOGO_DIR, 'audit.html'), htmlContent + `</div></body></html>`);
    console.log(`\n✅ Batch complete. Results in audit.html`);
}

async function convertToHighFidelity(inputPath, outputPath) {
    const image = sharp(inputPath).trim();
    const { data, info } = await image
        .resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // 1. Color Analysis
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        
        if (a < 128) continue; // Skip transparent
        
        // Skip pure White (Background) - We want to keep Black/Dark Grey!
        // We only filter out high brightness (white), NOT low saturation (grey/black).
        if (r > 240 && g > 240 && b > 240) continue; 

        const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        colorCounts[hex] = (colorCounts[hex] || 0) + 1;
    }

    // Get Top 3 colors to be safe (catches Black + Orange + maybe a 3rd accent)
    let sortedColors = Object.keys(colorCounts)
        .sort((a, b) => colorCounts[b] - colorCounts[a])
        .slice(0, 3);
    
    // Fallback: If logo was purely white/transparent or failed detection, use black
    if (sortedColors.length === 0) sortedColors = ['#000000'];

    let svgLayers = '';

    // 2. Multi-Layer Trace
    for (const color of sortedColors) {
        const rT = parseInt(color.slice(1, 3), 16);
        const gT = parseInt(color.slice(3, 5), 16);
        const bT = parseInt(color.slice(5, 7), 16);

        // A. Create Mask: Black (0) = Ink, White (255) = Paper
        const maskPixels = Buffer.alloc(info.width * info.height * 4);
        
        for (let i = 0; i < info.width * info.height; i++) {
            const idx = i * 4;
            const alpha = data[idx+3];

            // CRITICAL FIX FOR M&S: 
            // If the pixel is transparent, force it to WHITE (255).
            // Do NOT let it fall through to the distance check, because 0,0,0 (transparent) looks like Black!
            if (alpha < 128) {
                maskPixels[idx] = maskPixels[idx+1] = maskPixels[idx+2] = 255; 
                maskPixels[idx+3] = 255;
                continue;
            }

            const dist = Math.sqrt(
                Math.pow(data[idx]-rT,2) + 
                Math.pow(data[idx+1]-gT,2) + 
                Math.pow(data[idx+2]-bT,2)
            );

            // If color matches, make it BLACK (ink). Otherwise WHITE (paper).
            const val = dist < 60 ? 0 : 255; 
            
            maskPixels[idx] = val;    
            maskPixels[idx+1] = val;   
            maskPixels[idx+2] = val;   
            maskPixels[idx+3] = 255; // Always opaque for the tracer
        }

        // B. Convert to PNG to bypass "bitmap" error
        const pngBuffer = await sharp(maskPixels, {
            raw: { width: info.width, height: info.height, channels: 4 }
        }).png().toBuffer();

        // C. Trace
        const layerPath = await new Promise((resolve) => {
            potrace.trace(pngBuffer, { 
                turdSize: 4, // Increased slightly to ignore noise
                optTolerance: 0.2,
            }, (err, svg) => {
                if (err) return resolve('');
                const matches = svg.match(/d="[^"]+"/g);
                if (!matches) return resolve('');
                resolve(`<path ${matches.join(' ')} fill="${color}" fill-rule="evenodd" />`);
            });
        });
        svgLayers += layerPath;
    }

    const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${info.width} ${info.height}">${svgLayers}</svg>`;
    
    const result = optimize(fullSvg, {
        multipass: true,
        plugins: [
            'removeDimensions',
            { name: 'addAttributesToSVGElement', params: { attributes: [{ viewBox: '0 0 24 24' }, { width: '24' }, { height: '24' }] } }
        ]
    });

    fs.writeFileSync(outputPath, result.data);
    return sortedColors;
}

processAllLogos();