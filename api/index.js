const { MongoClient, ObjectId } = require('mongodb');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

let cachedDb = null;
async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  cachedDb = client.db('reward_stock_db');
  return cachedDb;
}

const getStatus = (r) => {
  if (r.warranty_date && new Date(r.warranty_date) < new Date()) return 'Expired';
  if (r.stock <= 0) return 'Out of Stock';
  if (r.stock <= 5) return 'Low Stock';
  return 'Available';
};

module.exports = async (req, res) => {
  try {
    const db = await connectDB();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method.toUpperCase();
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const filter = url.searchParams.get('filter');

    const adminPass = process.env.ADMIN_PASSWORD || '';
    if (path === '/api/config') {
      return res.status(200).json({ requireLogin: Boolean(adminPass) });
    }

    if (path === '/api/login' && method === 'POST') {
      const { password } = req.body || {};
      if (password === adminPass) {
        return res.status(200).json({ token: adminPass });
      }
      return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
    }

    if (adminPass) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${adminPass}`) {
        return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' });
      }
    }

    if (path === '/api/rewards' && method === 'GET') {
      let list = await db.collection('rewards').find({}).toArray();
      list = list.filter(r => (r.name || '').toLowerCase().includes(q)).map(r => ({
        ...r,
        status: getStatus(r)
      }));

      if (filter === 'available') {
        list = list.filter(r => r.status === 'Available' || r.status === 'Low Stock');
      } else if (filter === 'expiring') {
        const thirtyDays = Date.now() + 30 * 86400000;
        list = list.filter(r => r.status !== 'Expired' && r.warranty_date && new Date(r.warranty_date) <= thirtyDays);
      }
      return res.status(200).json(list);
    }

    if (path === '/api/rewards' && method === 'POST') {
      const body = req.body || {};
      const name = (body.name || '').trim();
      const stock = parseInt(body.stock, 10);
      const recipient = (body.recipient || '').trim();

      if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อของรางวัล' });
      if (!(stock > 0)) return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
      if (!recipient) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้รับเข้า' });

      let image_url = '';
      if (body.image && body.image.startsWith('data:image')) {
        const uploadRes = await cloudinary.uploader.upload(body.image, {
          folder: 'rewards_stock'
        });
        image_url = uploadRes.secure_url;
      }

      const newReward = {
        name,
        stock,
        note: body.note || '',
        image_url,
        warranty_date: body.warranty_date || null,
        created_at: new Date().toISOString()
      };

      const result = await db.collection('rewards').insertOne(newReward);
      await db.collection('transactions').insertOne({
        type: 'IN',
        quantity: stock,
        recipient,
        note: newReward.note,
        name,
        reward_id: result.insertedId.toString(),
        timestamp: body.date ? new Date(body.date).toISOString() : new Date().toISOString()
      });

      return res.status(201).json({ ...newReward, _id: result.insertedId });
    }

    const dispenseMatch = path.match(/^\/api\/rewards\/(.+)\/dispense$/);
    if (dispenseMatch && method === 'POST') {
      const rewardId = dispenseMatch[1];
      const body = req.body || {};
      const qty = parseInt(body.quantity, 10);
      const recipient = (body.recipient || '').trim();

      if (!(qty > 0)) return res.status(400).json({ error: 'จำนวนต้องมากกว่า 0' });
      if (!recipient) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้เบิก' });

      const reward = await db.collection('rewards').findOne({ _id: new ObjectId(rewardId) });
      if (!reward || reward.stock < qty || getStatus(reward) === 'Expired') {
        return res.status(400).json({ error: 'สต๊อกไม่พอ หรือของหมดอายุแล้ว' });
      }

      await db.collection('rewards').updateOne(
        { _id: new ObjectId(rewardId) },
        { $inc: { stock: -qty } }
      );

      await db.collection('transactions').insertOne({
        type: 'OUT',
        quantity: qty,
        recipient,
        note: body.note || '',
        name: reward.name,
        reward_id: rewardId,
        timestamp: body.date ? new Date(body.date).toISOString() : new Date().toISOString()
      });

      return res.status(200).json({ ...reward, stock: reward.stock - qty });
    }

    if (path === '/api/transactions' && method === 'GET') {
      let txList = await db.collection('transactions').find({}).sort({ timestamp: -1 }).toArray();
      if (q) {
        txList = txList.filter(t => [t.recipient, t.name, t.note].some(x => (x || '').toLowerCase().includes(q)));
      }
      return res.status(200).json(txList);
    }

    return res.status(404).json({ error: 'ไม่พบคำสั่ง API นี้' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
