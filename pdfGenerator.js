import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Genera una Boleta de Venta Electrónica formal con QR y cláusulas legales
 */
export async function generateInvoicePDF(data) {
    const { 
        orderId, 
        email, 
        amount, 
        credits, 
        description,
        clientName = ''
    } = data;
    
    return new Promise(async (resolve, reject) => {
        try {
            if (!orderId || !amount || !email) throw new Error('Datos incompletos para generar PDF');
            
            const montoTotal = parseFloat(amount);
            
            // Lógica SUNAT para Cliente
            let nombreCliente = "CLIENTES VARIOS";
            if (montoTotal > 700) {
                if (!clientName || clientName.trim() === "") {
                    throw new Error('Para montos mayores a S/ 700 es obligatorio el nombre del cliente.');
                }
                nombreCliente = clientName.toUpperCase();
            } else if (clientName && clientName.trim() !== "") {
                nombreCliente = clientName.toUpperCase();
            }

            const emisor = {
                razonSocial: 'CUBAS PEREZ JOSE RENE',
                ruc: '10736224351',
                direccion: 'Caserío Pajonal, Cajamarca',
                tipoDoc: 'BOLETA DE VENTA ELECTRÓNICA',
                serie: 'B001'
            };

            const correlativo = String(orderId).slice(-8).padStart(8, '0');
            const numeracion = `${emisor.serie}-${correlativo}`;
            const opGravada = montoTotal / 1.18;
            const igv = montoTotal - opGravada;

            // Usar la fecha de compra persistida; si no existe, conservar el comportamiento anterior.
            const fechaPersistida = data.date ? new Date(data.date) : new Date();
            const ahora = Number.isNaN(fechaPersistida.getTime()) ? new Date() : fechaPersistida;
            const opcionesFecha = { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            };
            const fechaFormateada = ahora.toLocaleDateString('es-PE', opcionesFecha);
            const horaFormateada = ahora.toLocaleTimeString('es-PE', { 
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
            });
            const fechaHoraCompleta = `${fechaFormateada}, ${horaFormateada}`;

            // Generar QR según estándar SUNAT (RUC|Tipo|Serie|Correlativo|IGV|Total|Fecha|TipoDocAdq|NumDocAdq)
            const dia = String(ahora.getDate()).padStart(2, '0');
            const mes = String(ahora.getMonth() + 1).padStart(2, '0');
            const anio = ahora.getFullYear();
            const fechaQR = `${dia}/${mes}/${anio}`; // Formato DD/MM/AAAA para QR SUNAT
            
            // Para boletas menores a 700, el adquirente puede ser no identificado (tipo 0, num -)
            const tipoDocAdq = montoTotal > 700 ? '1' : '-'; // 1 para DNI si es > 700, o según corresponda
            const numDocAdq = montoTotal > 700 ? (data.clientDocument || '-') : '-';
            
            // Contenido del QR estándar SUNAT
            const sunatQR = `${emisor.ruc}|03|${emisor.serie}|${correlativo}|${igv.toFixed(2)}|${montoTotal.toFixed(2)}|${fechaQR}|${tipoDocAdq}|${numDocAdq}|`;
            
            // URL de verificación para validez y respaldo
            const hostUrl = process.env.HOST_URL || 'https://comprar-creditos-consulta-pe.fly.dev';
            const verificationUrl = `${hostUrl}/verify.html?id=${orderId}`;
            
            // Generar QR que contiene la URL de verificación (que a su vez muestra los datos reales)
            const qrDataUrl = await QRCode.toDataURL(verificationUrl);

            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            const fileName = `boleta_${orderId}_${Date.now()}.pdf`;
            const publicDir = path.join(__dirname, 'public', 'invoices');
            
            if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
            
            const filePath = path.join(publicDir, fileName);
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            const colors = { black: '#000000', darkGray: '#333333', lightGray: '#f9f9f9', borderGray: '#cccccc' };

            // --- ENCABEZADO ---
            doc.font('Helvetica-Bold').fontSize(14).fillColor(colors.black).text(emisor.razonSocial, 40, 50);
            doc.font('Helvetica').fontSize(9).fillColor(colors.darkGray)
               .text(`RUC: ${emisor.ruc}`, 40, 70)
               .text(emisor.direccion, 40, 82)
               .text('Cajamarca - Perú', 40, 94);

            // RECUADRO TITULO (Ajustado en altura para el texto)
            doc.rect(350, 45, 200, 90).stroke(colors.black);
            doc.font('Helvetica-Bold').fontSize(12).text(`RUC: ${emisor.ruc}`, 350, 55, { width: 200, align: 'center' });
            
            // Fondo negro para el tipo de documento (Altura aumentada)
            doc.rect(350, 75, 200, 35).fill(colors.black);
            doc.fillColor('#FFFFFF').fontSize(10).text(emisor.tipoDoc, 350, 86, { width: 200, align: 'center' });
            
            doc.fillColor(colors.black).fontSize(12).text(numeracion, 350, 115, { width: 200, align: 'center' });

            // --- DATOS DEL CLIENTE ---
            // Calcular altura dinámica para el recuadro del cliente basado en la longitud de la fecha/hora
            const fechaText = `Fecha de Emisión: ${fechaHoraCompleta}`;
            const fechaLineHeight = 12;
            const fechaTextWidth = doc.widthOfString(fechaText, { fontSize: 9 });
            const maxWidth = 150; // Ancho máximo disponible para la fecha
            const fechaLines = Math.ceil(fechaTextWidth / maxWidth);
            
            const baseClientBoxHeight = 65;
            const extraHeight = (fechaLines - 1) * fechaLineHeight;
            const clientBoxHeight = baseClientBoxHeight + Math.max(0, extraHeight);
            
            doc.rect(40, 150, 510, clientBoxHeight).stroke(colors.borderGray);
            doc.font('Helvetica-Bold').fontSize(9).text('ADQUIRENTE:', 50, 160);
            doc.font('Helvetica').text(`Señor(es): ${nombreCliente}`, 50, 175);
            doc.text(`Email: ${email}`, 50, 187);
            
            // Fecha con salto de línea automático si es necesario
            doc.text(fechaText, 350, 160, { 
                width: maxWidth,
                lineGap: 2
            });
            
            doc.text('Moneda: SOLES (S/)', 350, 160 + (fechaLines * fechaLineHeight));

            // --- TABLA ---
            // Calcular posición Y de la tabla basada en la altura dinámica del recuadro del cliente
            const tableY = 150 + clientBoxHeight + 15;
            
            doc.rect(40, tableY, 510, 20).fill(colors.black);
            doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
            doc.text('CANT.', 45, tableY + 6);
            doc.text('DESCRIPCIÓN', 100, tableY + 6);
            doc.text('P. UNIT', 400, tableY + 6);
            doc.text('IMPORTE', 480, tableY + 6);

            // Descripción con altura dinámica
            const descripcionTexto = description || 'Servicio de Acceso a Infraestructura Digital';
            const descripcionWidth = 280; // Ancho disponible para descripción
            const descripcionLineHeight = 12;
            
            // Calcular altura necesaria para la descripción
            const descripcionHeight = doc.heightOfString(descripcionTexto, {
                width: descripcionWidth,
                lineGap: 2
            });
            
            const itemHeight = Math.max(30, descripcionHeight + 10); // Altura mínima de 30, más si la descripción es larga
            
            doc.fillColor(colors.black).font('Helvetica').text('1.00', 45, tableY + 30);
            doc.text(descripcionTexto, 100, tableY + 30, { 
                width: descripcionWidth,
                lineGap: 2
            });
            doc.text(`S/ ${montoTotal.toFixed(2)}`, 400, tableY + 30);
            doc.text(`S/ ${montoTotal.toFixed(2)}`, 480, tableY + 30);

            // Línea divisoria inferior de la tabla
            doc.rect(40, tableY + itemHeight + 10, 510, 1).fill(colors.borderGray).stroke(colors.borderGray);

            // --- TOTALES ---
            const totalsY = tableY + itemHeight + 30;
            doc.font('Helvetica').fontSize(9);
            doc.text('Op. Gravada:', 400, totalsY);
            doc.text(`S/ ${opGravada.toFixed(2)}`, 480, totalsY);
            doc.text('IGV (18%):', 400, totalsY + 15);
            doc.text(`S/ ${igv.toFixed(2)}`, 480, totalsY + 15);
            doc.font('Helvetica-Bold').fontSize(11).text('TOTAL:', 400, totalsY + 35);
            doc.text(`S/ ${montoTotal.toFixed(2)}`, 480, totalsY + 35);

            // --- PIE DE PÁGINA (QR, LEYENDAS Y RENUNCIA) ---
            // Calcular posición Y del footer basada en la altura dinámica de todo el contenido anterior
            const footerY = totalsY + 80;
            
            doc.image(qrDataUrl, 40, footerY, { width: 85 });

            doc.font('Helvetica').fontSize(7).fillColor('#666666');
            doc.text('Representación impresa de la Boleta de Venta Electrónica.', 140, footerY + 5);
            doc.text('Consulte la validez de su comprobante en la página oficial de la SUNAT.', 140, footerY + 15);
            doc.text('Bienes transferidos en la Amazonía para ser consumidos en la misma.', 140, footerY + 25);
            
            // RENUNCIA DE RESPONSABILIDAD / PRIVACIDAD
            doc.font('Helvetica-Bold').text('CLÁUSULA DE PROTECCIÓN DE DATOS:', 140, footerY + 40);
            doc.font('Helvetica').fontSize(6).text(
                'De acuerdo a la Ley N° 29733, el usuario autoriza a CONSULTA PE al tratamiento de sus datos personales para fines de facturación y soporte técnico. ' +
                'Este documento no es canjeable por dinero. El acceso al servicio es personal e intransferible. ' +
                'CONSULTA PE no se responsabiliza por el mal uso de los datos obtenidos a través de la plataforma por parte del usuario.', 
                140, footerY + 50, { width: 380, align: 'justify' }
            );

            doc.font('Helvetica-Bold').fontSize(9).fillColor(colors.black).text('¡Gracias por confiar en Masitaprex LATAM!', 140, footerY + 80);

            doc.end();
            stream.on('finish', () => resolve(filePath));
        } catch (error) {
            reject(error);
        }
    });
}
