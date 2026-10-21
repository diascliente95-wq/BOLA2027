'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const EfiPay = require('sdk-node-apis-efi');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: (process.env.FRONTEND_ORIGIN || 'https://diascliente95-wq.github.io').split(',').map(s=>s.trim()), methods:['GET','POST'], allowedHeaders:['Content-Type'] }));
app.use(express.json({ limit:'32kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

function required(name){const v=process.env[name];if(!v)throw new Error('Variável de ambiente ausente: '+name);return v;}
function initFirebase(){
  if(admin.apps.length)return admin.database();
  const serviceAccount=JSON.parse(required('FIREBASE_SERVICE_ACCOUNT_JSON'));
  admin.initializeApp({credential:admin.credential.cert(serviceAccount),databaseURL:required('FIREBASE_DATABASE_URL')});
  return admin.database();
}
function initEfi(){
  const certB64=required('EFI_CERTIFICATE_BASE64');
  const certPath=path.join('/tmp','efi-pix-certificate.p12');
  fs.writeFileSync(certPath,Buffer.from(certB64,'base64'),{mode:0o600});
  return new EfiPay({sandbox:String(process.env.EFI_SANDBOX||'true').toLowerCase()==='true',client_id:required('EFI_CLIENT_ID'),client_secret:required('EFI_CLIENT_SECRET'),certificate:certPath});
}
let db,efi;
try{db=initFirebase();efi=initEfi();}catch(e){console.error('Configuração incompleta:',e.message);}

function publicError(res,e){console.error(e);res.status(500).json({error:'Não foi possível processar agora. Confira a configuração do servidor.'});}
function amountString(v){return (Math.round(Number(v)*100)/100).toFixed(2);}
app.get('/health',(req,res)=>res.json({ok:true,configured:Boolean(db&&efi),mode:String(process.env.EFI_SANDBOX||'true').toLowerCase()==='true'?'homologacao':'producao'}));

app.post('/api/pix/create',async(req,res)=>{
  try{
    if(!db||!efi)return res.status(503).json({error:'Backend PIX ainda não configurado.'});
    const {partidaId,nome,whatsapp,golsCasa,golsVisitante}=req.body||{};
    if(typeof partidaId!=='string'||!partidaId||typeof nome!=='string'||nome.trim().length<2||nome.trim().length>80||typeof whatsapp!=='string'||whatsapp.trim().length<8||whatsapp.trim().length>24)return res.status(400).json({error:'Confira nome, WhatsApp e partida.'});
    const gc=Number(golsCasa),gv=Number(golsVisitante);
    if(!Number.isInteger(gc)||!Number.isInteger(gv)||gc<0||gv<0||gc>20||gv>20)return res.status(400).json({error:'Placar inválido.'});
    const [ps,cs]=await Promise.all([db.ref('copaFeminina2027/partidas/'+partidaId).get(),db.ref('copaFeminina2027/config').get()]);
    if(!ps.exists())return res.status(404).json({error:'Partida não encontrada.'});
    const p=ps.val(),config=cs.val()||{};
    if(p.status==='fechado'||p.status==='finalizado')return res.status(409).json({error:'Esta partida não aceita mais palpites.'});
    const valor=Number(p.valor??config.valor??20);
    if(!Number.isFinite(valor)||valor<=0||valor>10000)return res.status(400).json({error:'Valor da partida inválido.'});
    const chave=required('EFI_PIX_KEY');
    const cobranca=await efi.pixCreateImmediateCharge({calendario:{expiracao:1800},valor:{original:amountString(valor)},chave,solicitacaoPagador:'Bolao Copa Feminina 2027',infoAdicionais:[{nome:'Partida',valor:String(p.timeCasa||'Time 1')+' x '+String(p.timeVisitante||'Time 2')},{nome:'Participante',valor:nome.trim().slice(0,50)}]});
    if(!cobranca||!cobranca.txid||!cobranca.pixCopiaECola)throw new Error('Efí não retornou txid e código Pix.');
    const ref=db.ref('copaFeminina2027/palpites').push();
    const now=admin.database.ServerValue.TIMESTAMP;
    const item={partidaId,nome:nome.trim(),whatsapp:whatsapp.trim(),golsCasa:gc,golsVisitante:gv,valor,confirmado:false,statusPagamento:'pendente',provedor:'efi',txid:cobranca.txid,criadoEm:now};
    const payment={palpiteId:ref.key,txid:cobranca.txid,valor:amountString(valor),status:'ATIVA',criadoEm:now};
    const updates={};
    updates['copaFeminina2027/palpites/'+ref.key]=item;
    updates['copaFeminina2027/pagamentos/'+cobranca.txid]=payment;
    await db.ref().update(updates);
    res.status(201).json({palpiteId:ref.key,txid:cobranca.txid,valor:amountString(valor),pixCopiaECola:cobranca.pixCopiaECola,expiraEmSegundos:1800});
  }catch(e){publicError(res,e);}
});

app.get('/api/pix/status/:id',async(req,res)=>{
  try{
    if(!db)return res.status(503).json({error:'Backend não configurado.'});
    const id=String(req.params.id||'');
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(id))return res.status(400).json({error:'Identificador inválido.'});
    const s=await db.ref('copaFeminina2027/palpites/'+id).get();
    if(!s.exists())return res.status(404).json({error:'Palpite não encontrado.'});
    const a=s.val();
    res.json({palpiteId:id,statusPagamento:a.statusPagamento||'pendente',confirmado:a.confirmado===true});
  }catch(e){publicError(res,e);}
});

// A URL secreta dificulta falsificação. Em produção, configure também mTLS no terminador TLS,
// conforme a documentação oficial Efí; valide o pagamento consultando a API antes de aprovar.
app.post('/api/efi/webhook/:secret/pix',async(req,res)=>{
  try{
    const expected=required('EFI_WEBHOOK_SECRET');
    if(!crypto.timingSafeEqual(Buffer.from(String(req.params.secret)),Buffer.from(expected)))return res.sendStatus(401);
    if(!db||!efi)return res.sendStatus(503);
    const pix=Array.isArray(req.body?.pix)?req.body.pix:[];
    for(const notification of pix){
      const txid=String(notification.txid||'');
      if(!txid)continue;
      const mapSnap=await db.ref('copaFeminina2027/pagamentos/'+txid).get();
      if(!mapSnap.exists())continue;
      const mapping=mapSnap.val();
      // Confirma o status diretamente na API Efí; nunca confie apenas no corpo do webhook.
      const charge=await efi.pixDetailCharge({txid});
      if(charge.status!=='CONCLUIDA')continue;
      const expectedAmount=amountString(mapping.valor);
      const paid=Array.isArray(charge.pix)?charge.pix.reduce((sum,x)=>sum+Number(x.valor||0),0):0;
      if(paid+0.00001<Number(expectedAmount))continue;
      const updates={};
      updates['copaFeminina2027/palpites/'+mapping.palpiteId+'/confirmado']=true;
      updates['copaFeminina2027/palpites/'+mapping.palpiteId+'/statusPagamento']='confirmado';
      updates['copaFeminina2027/palpites/'+mapping.palpiteId+'/confirmadoEm']=admin.database.ServerValue.TIMESTAMP;
      updates['copaFeminina2027/pagamentos/'+txid+'/status']='CONCLUIDA';
      updates['copaFeminina2027/pagamentos/'+txid+'/pagoEm']=admin.database.ServerValue.TIMESTAMP;
      await db.ref().update(updates);
    }
    return res.sendStatus(200);
  }catch(e){console.error('Webhook Efí:',e.message);return res.sendStatus(500);}
});

const port=Number(process.env.PORT||3000);
app.listen(port,'0.0.0.0',()=>console.log('API PIX do Bolão iniciada na porta '+port));
