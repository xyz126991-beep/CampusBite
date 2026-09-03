import express from 'express';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-campusbite-secret';
if (!DATABASE_URL) console.warn('DATABASE_URL is not set. The server cannot use PostgreSQL until it is configured.');
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }) : null;
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const shops = ['Hari Sandwich','Reo Store','Campus Café'];
const statusNames = ['Received','Preparing','Ready','Completed'];
const customerProfileRoles = {
  'CB2026001': 'teacher',
  'CB2026002': 'student'
};

async function db(){ if(!pool) throw new Error('DATABASE_URL is not configured'); return pool; }
async function init(){
  if(!pool) return;
  // Ensure the complete database schema exists before running migrations/seeding.
  // This is important for fresh Render/Supabase databases where menu_items and
  // the other tables do not exist yet.
  await pool.query(schema);
  // Backward-compatible migration: older orders used the creation day implicitly.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_date DATE`);
  await pool.query(`UPDATE orders SET pickup_date=(created_at AT TIME ZONE 'Asia/Kolkata')::date WHERE pickup_date IS NULL`);
  await pool.query(`ALTER TABLE orders ALTER COLUMN pickup_date SET DEFAULT CURRENT_DATE`);
  await pool.query(`ALTER TABLE orders ALTER COLUMN pickup_date SET NOT NULL`);
  // Backward-compatible inventory migration for existing databases.
  await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock INTEGER`);
  // Wallet transaction metadata migration: link order debits to the actual order.
  await pool.query(`ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS wallet_tx_order_idx ON wallet_transactions(order_id)`);
  // Enrich legacy order debits so existing wallet history also shows the food and shop.
  await pool.query(`
    WITH legacy_matches AS (
      SELECT wt2.id AS wallet_tx_id,
             o.id AS order_id,
             CASE WHEN jsonb_array_length(o.items)>1
                  THEN COALESCE(o.items->0->>'name','CampusBite order') || ' + ' || (jsonb_array_length(o.items)-1)::text || ' more'
                  ELSE COALESCE(o.items->0->>'name','CampusBite order') || CASE WHEN COALESCE((o.items->0->>'q')::int,1)>1 THEN ' × ' || (o.items->0->>'q') ELSE '' END
             END AS food_title,
             o.shop || ' • ' || o.public_id AS shop_sub,
             ROW_NUMBER() OVER (
               PARTITION BY wt2.id
               ORDER BY ABS(EXTRACT(EPOCH FROM (o.created_at-wt2.created_at))) ASC
             ) AS match_rank
      FROM wallet_transactions wt2
      JOIN orders o
        ON o.customer_id=wt2.customer_id
       AND ABS(EXTRACT(EPOCH FROM (o.created_at-wt2.created_at))) <= 120
       AND ABS(o.total-wt2.amount) < 0.01
      WHERE wt2.type='debit'
        AND wt2.title='CampusBite order'
        AND wt2.order_id IS NULL
    )
    UPDATE wallet_transactions AS wt
    SET order_id = m.order_id,
        title = m.food_title,
        sub = m.shop_sub
    FROM legacy_matches AS m
    WHERE m.match_rank=1
      AND wt.id=m.wallet_tx_id
  `);
  // Fictional demo customer accounts only. Any legacy/non-demo accounts are
  // removed so real institutional credentials cannot remain in the prototype.
  await pool.query(`DELETE FROM customers WHERE customer_code NOT LIKE 'CB%'`);
  const customers=[
    ['CB2026001','Aarav Sharma','','Campus@123'],
    ['CB2026002','Diya Nair','','Campus@456']
  ];
  for(const [reg,name,year,pw] of customers){
    const hash=await bcrypt.hash(pw,10);
    await pool.query(
      `INSERT INTO customers(customer_code,name,year,password_hash)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(customer_code) DO UPDATE SET name=EXCLUDED.name,year=EXCLUDED.year,password_hash=EXCLUDED.password_hash`,
      [reg,name,year,hash]
    );
    await pool.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type)
      SELECT id,'💳','Wallet loaded','Demo opening balance',1250,'credit'
      FROM customers WHERE customer_code=$1
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt JOIN customers sx ON sx.id=wt.customer_id
                      WHERE sx.customer_code=$1 AND wt.title='Wallet loaded')`,[reg]);
    await pool.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type)
      SELECT id,'🎁','Welcome cashback','CampusBite reward',75,'credit'
      FROM customers WHERE customer_code=$1
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt JOIN customers sx ON sx.id=wt.customer_id
                      WHERE sx.customer_code=$1 AND wt.title='Welcome cashback')`,[reg]);
  }
  for(const shop of shops){
    const hash=await bcrypt.hash('1234',10);
    await pool.query(`INSERT INTO staff_users(name,shop,pin_hash) VALUES($1,$2,$3) ON CONFLICT(shop) DO NOTHING`,[shop+' Staff',shop,hash]);
  }
  const menu=[
    [101,'Hari Sandwich','Chicken Sandwich',75,18],[102,'Hari Sandwich','Veg Club Sandwich',65,16],[103,'Hari Sandwich','Paneer Wrap',80,14],[104,'Hari Sandwich','Cheese Toastie',55,20],
    [201,'Reo Store','Lays Classic',30,30],[202,'Reo Store','French Fries',25,25],[203,'Reo Store','Cold Cola',40,22],[204,'Reo Store','Mango Drink',35,18],
    [301,'Campus Café','Cappuccino',75,14],[302,'Campus Café','Masala Chai',30,24],[303,'Campus Café','Veg Hakka Noodles',90,15],[304,'Campus Café','Chocolate Muffin',55,17]
  ];
  for(const [id,shop,name,price,stock] of menu) {
    await pool.query(`INSERT INTO menu_items(id,shop,name,price,stock) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET shop=EXCLUDED.shop,name=EXCLUDED.name,price=EXCLUDED.price`,[id,shop,name,price,stock]);
    await pool.query(`UPDATE menu_items SET stock=$1 WHERE id=$2 AND stock IS NULL`,[stock,id]);
  }

}
function tokenFor(payload){return jwt.sign(payload,JWT_SECRET,{expiresIn:'12h'});}
function auth(req,res,next){
  try{
    const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):'';
    req.user=jwt.verify(t,JWT_SECRET); next();
  }catch{res.status(401).json({error:'Unauthorized'});}
}
function role(r){return (req,res,next)=>{if(req.user?.role!==r)return res.status(403).json({error:'Forbidden'});next();};}
function serializeOrder(r){return {id:r.public_id,items:r.items,total:Number(r.total),status:Number(r.status),discount:Number(r.discount),slot:r.slot,pickupDate:r.pickup_date?String(r.pickup_date).slice(0,10):null,shop:r.shop,createdAt:new Date(r.created_at).getTime(),prepStartedAt:r.prep_started_at?new Date(r.prep_started_at).getTime():null,readyAt:r.ready_at?new Date(r.ready_at).getTime():null,completedAt:r.completed_at?new Date(r.completed_at).getTime():null,customerName:r.customer_name||null,customerCode:r.customer_code||null,rating:r.rating!=null?Number(r.rating):null,ratingCreatedAt:r.rating_created_at?new Date(r.rating_created_at).getTime():null};}
function serializeTx(r){return {icon:r.icon,title:r.title,sub:r.sub,amt:Number(r.amount),type:r.type,createdAt:new Date(r.created_at).getTime()};}

let dbReady = false;
app.get('/api/health',(req,res)=>{
  res.status(dbReady?200:200).json({
    ok:true,
    service:'CampusBite',
    database:dbReady?'ready':'initializing',
    time:new Date().toISOString()
  });
});
app.use('/api', (req,res,next)=>{
  if(req.path==='/health') return next();
  if(!dbReady) return res.status(503).json({error:'CampusBite database is still starting. Please try again in a few seconds.'});
  next();
});
app.post('/api/auth/customer',async(req,res)=>{
  try{const {customerCode,password,profileRole}=req.body; const r=(await (await db()).query('SELECT * FROM customers WHERE customer_code=$1',[String(customerCode||'').trim()])).rows[0];
    if(!r || !(await bcrypt.compare(String(password||''),r.password_hash))) return res.status(401).json({error:'Invalid customer ID or password'});
    const expectedProfileRole=customerProfileRoles[r.customer_code];
    if(!expectedProfileRole || String(profileRole||'').toLowerCase()!==expectedProfileRole) return res.status(403).json({error:'Select the correct profile type for this customer account.'});
    const token=tokenFor({role:'customer',id:r.id,customerCode:r.customer_code,profileRole:expectedProfileRole});
    res.json({token,user:{role:'customer',profileRole:expectedProfileRole,name:r.name,customerCode:r.customer_code,year:r.year}});
  }catch(e){console.error(e);res.status(500).json({error:'Login unavailable'});}
});
app.post('/api/auth/staff',async(req,res)=>{
  try{const {shop,pin,name}=req.body; if(!shops.includes(shop))return res.status(400).json({error:'Invalid shop'}); const r=(await (await db()).query('SELECT * FROM staff_users WHERE shop=$1',[shop])).rows[0];
    if(!r || !(await bcrypt.compare(String(pin||''),r.pin_hash))) return res.status(401).json({error:'Invalid staff PIN'});
    const token=tokenFor({role:'staff',id:r.id,shop:r.shop});
    res.json({token,user:{role:'staff',name:name?.trim()||r.name,shop:r.shop}});
  }catch(e){console.error(e);res.status(500).json({error:'Staff login unavailable'});}
});

app.get('/api/customer/state',auth,role('customer'),async(req,res)=>{
  try{const d=await db(); const s=(await d.query('SELECT * FROM customers WHERE id=$1',[req.user.id])).rows[0]; if(!s)return res.status(404).json({error:'Customer not found'});
    const os=(await d.query(`SELECT o.*, r.rating, r.created_at AS rating_created_at
      FROM orders o LEFT JOIN order_ratings r ON r.order_id=o.id
      WHERE o.customer_id=$1 ORDER BY o.created_at DESC`,[s.id])).rows;
    const tx=(await d.query('SELECT * FROM wallet_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[s.id])).rows;
    const firstOrderEligible=os.length===0;
    res.json({wallet:Number(s.wallet_balance),cashback:Number(s.cashback),autopay:{enabled:s.autopay_enabled,threshold:Number(s.autopay_threshold),amount:Number(s.autopay_amount)},orders:os.map(serializeOrder),transactions:tx.map(serializeTx),firstOrderEligible});
  }catch(e){console.error(e);res.status(500).json({error:'State unavailable'});}
});

app.post('/api/customer/order',auth,role('customer'),async(req,res)=>{
  const client=await (await db()).connect();
  try{
    const {items,slot,shop}=req.body;
    const allowedPickupSlots=new Set([
      'ASAP',
      '9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM',
      '12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM'
    ]);
    if(!shops.includes(shop)||!Array.isArray(items)||!items.length||!allowedPickupSlots.has(String(slot||'')))
      return res.status(400).json({error:'Please select a valid pickup time'});
    if(String(slot||'')!=='ASAP'){
      const m=String(slot).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      let h=Number(m?.[1]),min=Number(m?.[2]); const ap=String(m?.[3]||'').toUpperCase();
      if(ap==='AM'&&h===12)h=0; if(ap==='PM'&&h!==12)h+=12;
      const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
      const currentMinutes=Number(parts.find(x=>x.type==='hour')?.value||0)*60+Number(parts.find(x=>x.type==='minute')?.value||0);
      if(h*60+min<=currentMinutes) return res.status(400).json({error:'Please select a future pickup time'});
    }
    const normalized=items.map(i=>({id:Number(i.id),q:Number(i.q),name:String(i.name||''),emoji:String(i.emoji||'🍱')}));
    if(normalized.some(i=>!Number.isInteger(i.id)||!Number.isInteger(i.q)||i.q<1||i.q>20)) return res.status(400).json({error:'Invalid quantity'});
    const quantities=new Map();
    for(const i of normalized) quantities.set(i.id,(quantities.get(i.id)||0)+i.q);
    if([...quantities.values()].some(q=>q>20)) return res.status(400).json({error:'Invalid quantity'});
    await client.query('BEGIN');
    const s=(await client.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
    if(!s) throw new Error('Customer not found');
    const ids=[...new Set(normalized.map(i=>i.id))];
    const menuRows=(await client.query('SELECT id,shop,name,price,stock,available FROM menu_items WHERE id=ANY($1::int[]) FOR UPDATE',[ids])).rows;
    if(menuRows.length!==ids.length){ await client.query('ROLLBACK'); return res.status(400).json({error:'One or more menu items are unavailable'}); }
    const byId=new Map(menuRows.map(r=>[Number(r.id),r]));
    if(normalized.some(i=>{const m=byId.get(i.id);return !m||m.shop!==shop||!m.available})){ await client.query('ROLLBACK'); return res.status(400).json({error:'One or more selected items are unavailable'}); }
    if([...quantities.entries()].some(([id,q])=>Number(byId.get(id)?.stock ?? 0) < q)){
      await client.query('ROLLBACK');
      return res.status(400).json({error:'One or more selected items do not have enough stock'});
    }
    const calculatedSubtotal=normalized.reduce((sum,i)=>sum+Number(byId.get(i.id).price||0)*i.q,0);
    if(calculatedSubtotal<=0){ await client.query('ROLLBACK'); return res.status(400).json({error:'Invalid menu pricing'}); }
    // CAMPUS10 is strictly a first-order offer. Eligibility is checked server-side
    // so a customer cannot reuse the discount by changing browser state or payloads.
    const priorOrders=Number((await client.query('SELECT COUNT(*)::int AS count FROM orders WHERE customer_id=$1',[s.id])).rows[0].count||0);
    const discount=priorOrders===0 && Number(req.body.discount)>0 && calculatedSubtotal>=100 ? Math.round(calculatedSubtotal*0.10) : 0;
    const fee=3;
    const payable=calculatedSubtotal-discount+fee;
    if(Number(s.wallet_balance)<payable){ await client.query('ROLLBACK'); return res.status(400).json({error:'Insufficient wallet balance',balance:Number(s.wallet_balance)}); }
    const publicId='CB-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase();
    const storedItems=normalized.map(i=>({id:i.id,name:byId.get(i.id).name,price:Number(byId.get(i.id).price),q:i.q,emoji:i.emoji}));
    for(const [id,q] of quantities){
      await client.query('UPDATE menu_items SET stock=GREATEST(0,COALESCE(stock,0)-$1) WHERE id=$2',[q,id]);
    }
    await client.query('UPDATE customers SET wallet_balance=wallet_balance-$1 WHERE id=$2',[payable,s.id]);
    const row=(await client.query(`INSERT INTO orders(public_id,customer_id,shop,items,total,discount,slot,pickup_date) VALUES($1,$2,$3,$4,$5,$6,$7,(NOW() AT TIME ZONE 'Asia/Kolkata')::date) RETURNING *`,[publicId,s.id,shop,JSON.stringify(storedItems),payable,discount,slot||'ASAP'])).rows[0];
    const walletFoodSummary=storedItems.length===1 ? `${storedItems[0].name}${storedItems[0].q>1?` × ${storedItems[0].q}`:''}` : `${storedItems[0].name}${storedItems[0].q>1?` × ${storedItems[0].q}`:''} + ${storedItems.length-1} more`;
    const walletOrderSub=`${shop} • ${publicId}`;
    await client.query(`INSERT INTO wallet_transactions(customer_id,order_id,icon,title,sub,amount,type) VALUES($1,$2,'🍱',$3,$4,$5,'debit')`,[s.id,row.id,walletFoodSummary,walletOrderSub,payable]);
    let balance=Number(s.wallet_balance)-payable;
    const ns=(await client.query('SELECT * FROM customers WHERE id=$1',[s.id])).rows[0];
    if(ns.autopay_enabled && balance<=Number(ns.autopay_threshold)){
      const amount=Number(ns.autopay_amount); balance+=amount;
      await client.query('UPDATE customers SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,s.id]);
      await client.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'🔄','Auto-pay top-up',$2,$3,'credit')`,[s.id,`Automatic refill • threshold ₹${Number(ns.autopay_threshold)}`,amount]);
    }
    await client.query('COMMIT');
    res.json({order:serializeOrder(row),wallet:balance});
  }catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Could not place order'});}finally{client.release();}
});

app.patch('/api/customer/orders/:id/reschedule',auth,role('customer'),async(req,res)=>{
  const client=await (await db()).connect();
  const allowedRescheduleSlots=[
    '9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM',
    '12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM'
  ];
  const parseSlotMinutes=(slot)=>{const m=String(slot||'').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);if(!m)return null;let h=Number(m[1]),min=Number(m[2]);if(h<1||h>12||min<0||min>59)return null;const ap=m[3].toUpperCase();if(ap==='AM'&&h===12)h=0;if(ap==='PM'&&h!==12)h+=12;return h*60+min;};
  const indiaToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  try{
    const newSlot=String(req.body?.slot||'').trim();
    if(!allowedRescheduleSlots.includes(newSlot)) return res.status(400).json({error:'Please choose a valid pickup time'});
    await client.query('BEGIN');
    const order=(await client.query(`SELECT * FROM orders WHERE public_id=$1 AND customer_id=$2 FOR UPDATE`,[req.params.id,req.user.id])).rows[0];
    if(!order){await client.query('ROLLBACK');return res.status(404).json({error:'Order not found'});}
    if(Number(order.status)>=3){await client.query('ROLLBACK');return res.status(400).json({error:'Completed orders cannot be rescheduled'});}
    const orderDate=String(order.pickup_date||indiaToday()).slice(0,10);
    const today=indiaToday();
    if(orderDate!==today){await client.query('ROLLBACK');return res.status(400).json({error:'Only same-day pickup orders can be rescheduled'});}
    if(!order.slot || String(order.slot).toUpperCase()==='ASAP'){await client.query('ROLLBACK');return res.status(400).json({error:'Only scheduled orders can be rescheduled'});}
    const newMinutes=parseSlotMinutes(newSlot);
    const originalMinutes=parseSlotMinutes(order.slot);
    if(originalMinutes===null){await client.query('ROLLBACK');return res.status(400).json({error:'This order cannot be rescheduled'});}
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
    const currentMinutes=Number(parts.find(x=>x.type==='hour')?.value||0)*60+Number(parts.find(x=>x.type==='minute')?.value||0);
    if(newMinutes<=originalMinutes){await client.query('ROLLBACK');return res.status(400).json({error:`Please choose a pickup time later than ${order.slot}`});}
    if(newMinutes<=currentMinutes){await client.query('ROLLBACK');return res.status(400).json({error:'Please choose a future pickup time'});}
    const fee=(order.prep_started_at || Number(order.status)>=1)?15:0;
    const customer=(await client.query('SELECT wallet_balance FROM customers WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
    if(!customer)throw new Error('Customer not found');
    if(Number(customer.wallet_balance)<fee){await client.query('ROLLBACK');return res.status(400).json({error:'Insufficient wallet balance for the ₹15 rescheduling fee',balance:Number(customer.wallet_balance)});}
    const updated=(await client.query(`UPDATE orders SET slot=$1 WHERE id=$2 RETURNING *`,[newSlot,order.id])).rows[0];
    let balance=Number(customer.wallet_balance);
    if(fee>0){
      balance-=fee;
      await client.query('UPDATE customers SET wallet_balance=wallet_balance-$1 WHERE id=$2',[fee,req.user.id]);
      await client.query(`INSERT INTO wallet_transactions(customer_id,order_id,icon,title,sub,amount,type) VALUES($1,$2,'🔄','Reschedule fee',$3,$4,'debit')`,[req.user.id,order.id,`${order.shop} • ${order.public_id} • Pickup ${newSlot}`,fee]);
    }
    await client.query('COMMIT');
    res.json({order:serializeOrder(updated),wallet:balance,fee});
  }catch(e){try{await client.query('ROLLBACK');}catch{}console.error(e);res.status(500).json({error:'Could not reschedule order'});}finally{client.release();}
});

app.post('/api/customer/orders/:id/rating',auth,role('customer'),async(req,res)=>{
  try{
    const d=await db();
    const rating=Number(req.body?.rating);
    if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({error:'Please choose a rating from 1 to 5 stars'});
    const order=(await d.query('SELECT id,public_id,customer_id,shop,status FROM orders WHERE public_id=$1 AND customer_id=$2',[req.params.id,req.user.id])).rows[0];
    if(!order)return res.status(404).json({error:'Order not found'});
    if(Number(order.status)!==3)return res.status(400).json({error:'You can rate an order after it is completed'});
    const out=(await d.query(`INSERT INTO order_ratings(order_id,customer_id,shop,rating) VALUES($1,$2,$3,$4)
      ON CONFLICT(order_id) DO UPDATE SET rating=EXCLUDED.rating,updated_at=NOW()
      RETURNING rating,created_at`,[order.id,req.user.id,order.shop,rating])).rows[0];
    res.json({rating:Number(out.rating),createdAt:new Date(out.created_at).getTime()});
  }catch(e){console.error(e);res.status(500).json({error:'Could not save rating'});}
});

app.post('/api/customer/wallet/topup',auth,role('customer'),async(req,res)=>{try{const d=await db(),amount=Number(req.body.amount);if(![250,500,1000,2000].includes(amount))return res.status(400).json({error:'Invalid amount'});await d.query('UPDATE customers SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,req.user.id]);await d.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'💰','Wallet top-up','Demo wallet load',$2,'credit')`,[req.user.id,amount]);const s=(await d.query('SELECT wallet_balance FROM customers WHERE id=$1',[req.user.id])).rows[0];res.json({wallet:Number(s.wallet_balance)});}catch(e){console.error(e);res.status(500).json({error:'Top-up failed'});}});
app.post('/api/customer/autopay',auth,role('customer'),async(req,res)=>{const client=await (await db()).connect();try{const enabled=!!req.body.enabled,threshold=Number(req.body.threshold)||200,amount=Number(req.body.amount)||500;await client.query('BEGIN');const s=(await client.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];if(!s)throw new Error('Customer not found');await client.query('UPDATE customers SET autopay_enabled=$1,autopay_threshold=$2,autopay_amount=$3 WHERE id=$4',[enabled,threshold,amount,req.user.id]);let balance=Number(s.wallet_balance);if(enabled && balance<=threshold){balance+=amount;await client.query('UPDATE customers SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,req.user.id]);await client.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'🔄','Auto-pay top-up',$2,$3,'credit')`,[req.user.id,`Automatic refill • threshold ₹${threshold}`,amount]);}await client.query('COMMIT');res.json({autopay:{enabled,threshold,amount},wallet:balance});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Auto-pay update failed'});}finally{client.release();}});


app.get('/api/canteen/status',async(req,res)=>{
  try{
    const d=await db();
    const out={};
    for(const shop of shops){
      const avgRow=(await d.query(`SELECT AVG(EXTRACT(EPOCH FROM (ready_at-prep_started_at))/60.0) AS avg_prep FROM orders WHERE shop=$1 AND prep_started_at IS NOT NULL AND ready_at IS NOT NULL AND ready_at >= NOW()-INTERVAL '30 days'`,[shop])).rows[0];
      const avgPrep=Math.max(3,Math.min(30,Number(avgRow?.avg_prep)||5));
      const rows=(await d.query(`SELECT status,created_at,prep_started_at FROM orders WHERE shop=$1 AND status < 3 ORDER BY created_at ASC`,[shop])).rows;
      let wait=0;
      for(const o of rows){
        if(Number(o.status)===1 && o.prep_started_at){
          const elapsed=Math.max(0,(Date.now()-new Date(o.prep_started_at).getTime())/60000);
          wait+=Math.max(0.5,avgPrep-elapsed);
        }else{
          wait+=avgPrep;
        }
      }
      out[shop]={activeOrders:rows.length,averagePrepMinutes:Math.round(avgPrep*10)/10,waitMinutes:rows.length?Math.max(1,Math.ceil(wait)):0};
    }
    res.json({shops:out,updatedAt:new Date().toISOString()});
  }catch(e){console.error(e);res.status(500).json({error:'Canteen status unavailable'});}
});


// ML-based Food Waste Helper: forecasts tomorrow's item-level demand using
// historical daily sales. A small Ridge regression is trained per menu item
// from lagged demand, rolling averages, trend and weekday features.
function ridgeSolve(X,y,lambda=1.0){
  const p=X[0]?.length||0; if(!p||!X.length)return Array(p).fill(0);
  const A=Array.from({length:p},()=>Array(p).fill(0)); const b=Array(p).fill(0);
  for(let r=0;r<X.length;r++){ for(let i=0;i<p;i++){ b[i]+=X[r][i]*y[r]; for(let j=0;j<p;j++)A[i][j]+=X[r][i]*X[r][j]; } }
  for(let i=1;i<p;i++)A[i][i]+=lambda;
  for(let i=0;i<p;i++){ let pivot=i; for(let r=i+1;r<p;r++)if(Math.abs(A[r][i])>Math.abs(A[pivot][i]))pivot=r; if(Math.abs(A[pivot][i])<1e-9)continue; [A[i],A[pivot]]=[A[pivot],A[i]]; [b[i],b[pivot]]=[b[pivot],b[i]]; const q=A[i][i]; for(let j=i;j<p;j++)A[i][j]/=q; b[i]/=q; for(let r=0;r<p;r++){if(r===i)continue; const f=A[r][i]; if(!f)continue; for(let j=i;j<p;j++)A[r][j]-=f*A[i][j]; b[r]-=f*b[i];}}
  return b;
}
function dayKey(d){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function addDaysKey(key,n){const d=new Date(key+'T00:00:00+05:30'); d.setDate(d.getDate()+n); return dayKey(d);}
function featuresFor(series,key){
  const vals=n=>Math.max(0,Number(series[addDaysKey(key,-n)]||0));
  const avg=(n)=>{let z=0;for(let i=1;i<=n;i++)z+=vals(i);return z/n};
  const a7=avg(7),a14=avg(14);
  let trend=0; for(let i=1;i<=7;i++)trend+=(vals(i)-vals(i+7));
  const d=new Date(key+'T00:00:00+05:30'); const dow=d.getDay();
  const x=[1,vals(1),vals(7),a7,a14,trend/7]; for(let k=1;k<7;k++)x.push(dow===k?1:0); return x;
}
app.get('/api/staff/waste-baselines',auth,role('staff'),async(req,res)=>{
  try{const d=await db();const rows=(await d.query('SELECT menu_item_id,initial_expected FROM waste_forecast_baselines WHERE shop=$1',[req.user.shop])).rows;res.json({shop:req.user.shop,baselines:rows.map(r=>({menuItemId:Number(r.menu_item_id),initialExpected:Number(r.initial_expected)}))});}
  catch(e){console.error(e);res.status(500).json({error:'Opening estimates unavailable'});}
});
app.put('/api/staff/waste-baselines',auth,role('staff'),async(req,res)=>{
  try{const d=await db();const items=Array.isArray(req.body?.items)?req.body.items:[];if(!items.length)return res.status(400).json({error:'No opening estimates provided'});
    for(const x of items){const id=Number(x.menuItemId),v=Number(x.initialExpected);if(!Number.isInteger(id)||!Number.isFinite(v)||v<0||v>100000)return res.status(400).json({error:'Invalid opening estimate'});
      await d.query(`INSERT INTO waste_forecast_baselines(shop,menu_item_id,initial_expected) VALUES($1,$2,$3) ON CONFLICT(shop,menu_item_id) DO UPDATE SET initial_expected=EXCLUDED.initial_expected,updated_at=NOW()`,[req.user.shop,id,Math.floor(v)]);}
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Opening estimates could not be saved'});}
});
app.get('/api/staff/waste-forecast',auth,role('staff'),async(req,res)=>{
  try{
    const d=await db();
    const menu=(await d.query('SELECT id,shop,name,stock,available FROM menu_items WHERE shop=$1 ORDER BY id',[req.user.shop])).rows;
    const baselineRows=(await d.query('SELECT menu_item_id,initial_expected FROM waste_forecast_baselines WHERE shop=$1',[req.user.shop])).rows;
    const openingBaseline=Object.fromEntries(baselineRows.map(r=>[Number(r.menu_item_id),Math.max(0,Number(r.initial_expected))]));
    const rows=(await d.query(`SELECT created_at,items FROM orders WHERE shop=$1 AND created_at >= NOW()-INTERVAL '120 days' ORDER BY created_at ASC`,[req.user.shop])).rows;
    const byItem={};
    let firstOrderKey=null;
    for(const row of rows){const key=dayKey(new Date(row.created_at)); if(!firstOrderKey||key<firstOrderKey)firstOrderKey=key; for(const item of (Array.isArray(row.items)?row.items:[])){const id=Number(item.id); if(!id)continue; if(!byItem[id])byItem[id]={}; byItem[id][key]=(byItem[id][key]||0)+Number(item.q||0);}}
    const today=dayKey(new Date()), tomorrow=addDaysKey(today,1);
    const calendarDaysSinceStart=firstOrderKey?Math.max(1,Math.round((new Date(today+'T00:00:00+05:30')-new Date(firstOrderKey+'T00:00:00+05:30'))/86400000)+1):0;
    const result=menu.map(item=>{
      const series=byItem[item.id]||{}; const stock=Math.max(0,Number(item.stock||0));
      // Build training rows only from days that actually fall within the business lifetime.
      // We still allow the model to use the 14 days immediately before a training target as
      // lag features, but never create pre-launch zero-sales targets.
      const last90Start=addDaysKey(today,-90);
      const trainingStart=firstOrderKey?addDaysKey(firstOrderKey,14):null;
      const startKey=trainingStart&&trainingStart>last90Start?trainingStart:last90Start;
      const dates=[]; if(startKey){for(let k=startKey;k<today;k=addDaysKey(k,1))dates.push(k);}
      const X=[],y=[]; for(const k of dates){X.push(featuresFor(series,k)); y.push(Math.max(0,Number(series[k]||0)));}
      const itemSoldDays=Object.keys(series).filter(k=>Number(series[k]||0)>0).length;
      let prediction,method='Ridge ML';
      if(!rows.length){
        // True Day-1 cold start: no CampusBite sales exist anywhere yet. Use the staff-entered
        // opening estimate; never invent a machine-learning forecast.
        prediction=openingBaseline[item.id]??stock; method=openingBaseline[item.id]!=null?'Opening estimate':'Current stock baseline';
      }else if(itemSoldDays===0 && openingBaseline[item.id]!=null){
        // A menu item with no observed sales yet has no item-level demand signal. Keep using the
        // staff-entered opening estimate until that item has real observations.
        prediction=openingBaseline[item.id]; method='Opening estimate';
      }else if(calendarDaysSinceStart<28 || X.length<14){
        // Early-stage cold start: use only days inside the actual business lifetime. This is an
        // estimate, not ML, until enough history exists for a stable Ridge model.
        const observed=[]; for(let i=1;i<=Math.min(calendarDaysSinceStart,14);i++){
          const k=addDaysKey(today,-i); if(!firstOrderKey||k>=firstOrderKey)observed.push(Number(series[k]||0));
        }
        const avg=observed.length?observed.reduce((a,b)=>a+b,0)/observed.length:0;
        const sameDow=[]; for(let i=1;i<=4;i++){const k=addDaysKey(tomorrow,-7*i); if(firstOrderKey&&k>=firstOrderKey)sameDow.push(Number(series[k]||0));}
        const dowAvg=sameDow.length?sameDow.reduce((a,b)=>a+b,0)/sameDow.length:avg;
        prediction=Math.max(0,0.7*avg+0.3*dowAvg); method='Early-data estimate';
      }else{
        const beta=ridgeSolve(X,y,2.5); const raw=featuresFor(series,tomorrow).reduce((a,v,i)=>a+v*(beta[i]||0),0); prediction=Math.max(0,raw);
      }
      const predicted=Math.max(0,Math.round(prediction*10)/10);
      const target=Math.max(0,Math.ceil(predicted*1.08));
      const additionalPreparation=Math.max(0,target-stock);
      const cls=!item.available?'hold':additionalPreparation>0?'more':'same';
      const confidence=Math.min(92,Math.max(55,Math.round(55+Math.min(35,X.length/2))));
      const reason=cls==='hold'?'Item is currently unavailable.':additionalPreparation>0?'Additional preparation is required to reach the recommended stock level.':'Available stock already covers the recommended stock level.';
      return {id:item.id,name:item.name,stock,available:item.available,todaySold:Number(series[today]||0),predictedDemand:predicted,recommendedPrep:target,additionalPreparation,cls,confidence,method,reason,trainingDays:X.length,itemSoldDays,historyDays:calendarDaysSinceStart};
    });
    res.json({shop:req.user.shop,tomorrow,model:'Ridge Regression with cold-start handling',features:['previous-day sales','same-weekday sales','7-day average','14-day average','recent trend','day of week'],items:result,updatedAt:new Date().toISOString()});
  }catch(e){console.error(e);res.status(500).json({error:'Waste forecast unavailable'});}
});

app.get('/api/menu',async(req,res)=>{try{const d=await db();const rows=(await d.query('SELECT id,shop,name,price,stock,available FROM menu_items ORDER BY id')).rows;res.json({items:rows});}catch(e){console.error(e);res.status(500).json({error:'Menu unavailable'});}});
app.patch('/api/staff/menu/:id',auth,role('staff'),async(req,res)=>{
  try{
    const d=await db();
    const id=Number(req.params.id);
    if(!Number.isInteger(id)) return res.status(400).json({error:'Invalid menu item'});
    const row=(await d.query('SELECT * FROM menu_items WHERE id=$1',[id])).rows[0];
    if(!row) return res.status(404).json({error:'Menu item not found'});
    const canonicalShop=id>=100&&id<200?'Hari Sandwich':id>=200&&id<300?'Reo Store':id>=300&&id<400?'Campus Café':null;
    const sameShop=canonicalShop && (
      row.shop===req.user.shop ||
      row.shop.replace('é','e').toLowerCase()===String(req.user.shop).replace('é','e').toLowerCase()
    );
    if(!sameShop || canonicalShop!==req.user.shop) return res.status(403).json({error:'You cannot change another shop\'s menu'});
    const out=(await d.query(
      'UPDATE menu_items SET available=$1 WHERE id=$2 RETURNING id,shop,name,available',
      [!!req.body.available,row.id]
    )).rows[0];
    res.json({item:out});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Availability update failed'});
  }
});

app.get('/api/staff/orders',auth,role('staff'),async(req,res)=>{try{const d=await db();const rows=(await d.query(`SELECT o.*, s.name AS customer_name, s.customer_code, r.rating, r.created_at AS rating_created_at FROM orders o JOIN customers s ON s.id=o.customer_id LEFT JOIN order_ratings r ON r.order_id=o.id WHERE o.shop=$1 ORDER BY o.created_at DESC LIMIT 500`,[req.user.shop])).rows;res.json({orders:rows.map(serializeOrder)});}catch(e){console.error(e);res.status(500).json({error:'Orders unavailable'});}});
app.get('/api/staff/ratings',auth,role('staff'),async(req,res)=>{try{const d=await db();const summary=(await d.query(`SELECT COUNT(*)::int AS count, COALESCE(ROUND(AVG(rating)::numeric,1),0) AS average FROM order_ratings WHERE shop=$1`,[req.user.shop])).rows[0];const rows=(await d.query(`SELECT r.rating,r.created_at,o.public_id,c.name AS customer_name FROM order_ratings r JOIN orders o ON o.id=r.order_id JOIN customers c ON c.id=r.customer_id WHERE r.shop=$1 ORDER BY r.created_at DESC LIMIT 12`,[req.user.shop])).rows;res.json({average:Number(summary.average||0),count:Number(summary.count||0),ratings:rows.map(r=>({rating:Number(r.rating),createdAt:new Date(r.created_at).getTime(),orderId:r.public_id,customerName:r.customer_name||'Student'}))});}catch(e){console.error(e);res.status(500).json({error:'Ratings unavailable'});}});
app.patch('/api/staff/orders/:id/status',auth,role('staff'),async(req,res)=>{try{const d=await db();const row=(await d.query('SELECT * FROM orders WHERE public_id=$1 AND shop=$2',[req.params.id,req.user.shop])).rows[0];if(!row)return res.status(404).json({error:'Order not found'});if(Number(row.status)>=3)return res.status(400).json({error:'Order is already completed'});const next=Number(row.status)+1;if(next!==Number(req.body.status))return res.status(400).json({error:'Invalid next status'});let sql='UPDATE orders SET status=$1';const vals=[next,row.id];if(next===1)sql+=', prep_started_at=COALESCE(prep_started_at,NOW())';if(next===2)sql+=', ready_at=COALESCE(ready_at,NOW())';if(next===3)sql+=', completed_at=COALESCE(completed_at,NOW())';sql+=' WHERE id=$2 RETURNING *';const out=(await d.query(sql,vals)).rows[0];res.json({order:serializeOrder(out)});}catch(e){console.error(e);res.status(500).json({error:'Status update failed'});}});
app.get('/api/staff/summary',auth,role('staff'),async(req,res)=>{try{const d=await db();const day=req.query.date||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const rows=(await d.query(`SELECT * FROM orders WHERE shop=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,[req.user.shop,day])).rows;const revenue=rows.reduce((a,r)=>a+Number(r.total),0);const active=rows.filter(r=>r.status<3).length;res.json({date:day,orders:rows.length,revenue,active});}catch(e){console.error(e);res.status(500).json({error:'Summary unavailable'});}});

app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// Start HTTP immediately so Render can reach the service even while PostgreSQL
// is waking up or the first-time schema initialization is running.
async function initializeDatabaseWithRetry(){
  const maxAttempts = 6;
  for(let attempt=1; attempt<=maxAttempts; attempt++){
    try{
      await init();
      dbReady=true;
      console.log('CampusBite database initialization complete');
      return;
    }catch(e){
      dbReady=false;
      console.error(`CampusBite database initialization attempt ${attempt}/${maxAttempts} failed:`,e);
      if(attempt<maxAttempts){
        const delayMs = Math.min(3000 * attempt, 12000);
        console.log(`Retrying database initialization in ${delayMs}ms...`);
        await new Promise(resolve=>setTimeout(resolve,delayMs));
      }
    }
  }
  console.error('CampusBite database initialization failed after all retries.');
}

// Start HTTP immediately so Render can reach the service while PostgreSQL wakes up.
// Database initialization retries automatically, preventing a transient database
// wake-up from leaving demo accounts unseeded and the login permanently broken.
const server = app.listen(PORT,'0.0.0.0',()=>{
  console.log(`CampusBite listening on ${PORT}`);
  initializeDatabaseWithRetry();
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
