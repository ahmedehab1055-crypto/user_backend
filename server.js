require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('نوع الملف غير مسموح'));
  }
});

// ─── BABYSITTERS ───────────────────────────────────────────

app.get('/api/babysitters', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('babysitters')
      .select('id, name, experience, hourly_rate, specialties, profile_image, rating, availability')
      .eq('availability', true)
      .order('rating', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ babysitters: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/babysitters/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('babysitters')
      .select('*, reviews(id, rating, comment, created_at)')
      .eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'مش موجودة' });
    res.json({ babysitter: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── NURSES ────────────────────────────────────────────────

app.get('/api/nurses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nurses')
      .select('id, name, experience, hourly_rate, specialties, profile_image, rating, availability')
      .eq('availability', true)
      .order('rating', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ nurses: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/nurses/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nurses')
      .select('*')
      .eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'مش موجود' });
    res.json({ nurse: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── BOOKINGS ──────────────────────────────────────────────

app.get('/api/bookings', async (req, res) => {
  try {
    const { user_id, status } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });

    let query = supabase.from('bookings')
      .select(`
        id, booking_date, duration_hours, status, service,
        payment_method, total_price, notes,
        start_time, end_time, booking_type,
        babysitters ( id, name, profile_image, hourly_rate, rating ),
        nurses ( id, name, profile_image, hourly_rate, rating )
      `)
      .eq('user_id', user_id)
      .order('booking_date', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const babysitterBookings = data.filter(b => b.booking_type === 'babysitter');
    const nurseBookings      = data.filter(b => b.booking_type === 'nurse');

    let medical = null;
    if (nurseBookings.length > 0) {
      const { data: medData } = await supabase
        .from('medical_records').select('*').eq('user_id', user_id).maybeSingle();
      if (medData) {
        async function makeSignedUrls(jsonStr) {
          if (!jsonStr) return [];
          try {
            const paths = JSON.parse(jsonStr);
            return await Promise.all(paths.map(async (path) => {
              const { data } = await supabase.storage.from('medical-files').createSignedUrl(path, 3600);
              return { path, url: data?.signedUrl };
            }));
          } catch { return []; }
        }
        medical = {
          id: medData.id, created_at: medData.created_at,
          xrays:    await makeSignedUrls(medData.xray_urls),
          analyses: await makeSignedUrls(medData.analyses_urls),
          others:   await makeSignedUrls(medData.other_urls),
        };
      }
    }

    res.json({
      stats: {
        total:      data.length,
        completed:  data.filter(b => b.status === 'completed').length,
        pending:    data.filter(b => b.status === 'pending').length,
        cancelled:  data.filter(b => b.status === 'cancelled').length,
        totalSpent: data.reduce((s, b) => s + Number(b.total_price || 0), 0),
      },
      babysitter_bookings: babysitterBookings,
      nurse_bookings:      nurseBookings,
      medical,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookings/babysitter', async (req, res) => {
  try {
    const { user_id, user_email, babysitter_id, booking_date, duration_hours, service, payment_method, notes, start_time, end_time } = req.body;
    if (!user_id || !babysitter_id || !booking_date || !duration_hours)
      return res.status(400).json({ error: 'بيانات ناقصة' });

    const { data: sitter, error: sitterErr } = await supabase
      .from('babysitters').select('hourly_rate, availability').eq('id', babysitter_id).single();
    if (sitterErr || !sitter) return res.status(404).json({ error: 'الجليسة مش موجودة' });
    if (!sitter.availability) return res.status(400).json({ error: 'الجليسة مش متاحة' });

    const total_price = Number(sitter.hourly_rate) * Number(duration_hours);

    const { data, error } = await supabase.from('bookings')
      .insert({
        user_id, user_email, babysitter_id,
        booking_date, duration_hours,
        service: service || 'babysitter',
        payment_method: payment_method || 'cash_on_delivery',
        total_price, notes, status: 'pending',
        start_time, end_time, booking_type: 'babysitter'
      })
      .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ message: 'تم الحجز ✅', booking: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookings/nurse', async (req, res) => {
  try {
    const { user_id, user_email, nurse_id, booking_date, duration_hours, service, payment_method, notes, start_time, end_time } = req.body;
    if (!user_id || !nurse_id || !booking_date || !duration_hours)
      return res.status(400).json({ error: 'بيانات ناقصة' });

    const { data: nurse, error: nurseErr } = await supabase
      .from('nurses').select('hourly_rate, availability').eq('id', nurse_id).single();
    if (nurseErr || !nurse) return res.status(404).json({ error: 'الممرضة مش موجودة' });
    if (!nurse.availability) return res.status(400).json({ error: 'الممرضة مش متاحة' });

    const total_price = Number(nurse.hourly_rate) * Number(duration_hours);

    const { data, error } = await supabase.from('bookings')
      .insert({
        user_id, user_email, nurse_id,
        booking_date, duration_hours,
        service: service || 'nurse',
        payment_method: payment_method || 'cash_on_delivery',
        total_price, notes, status: 'pending',
        start_time, end_time, booking_type: 'nurse'
      })
      .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ message: 'تم الحجز ✅', booking: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/bookings/:id/cancel', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });

    const { data: booking, error } = await supabase
      .from('bookings').select('status, user_id').eq('id', req.params.id).single();
    if (error || !booking) return res.status(404).json({ error: 'الحجز مش موجود' });
    if (booking.user_id !== user_id) return res.status(403).json({ error: 'مش حجزك' });
    if (['cancelled', 'completed'].includes(booking.status))
      return res.status(400).json({ error: 'مينفعش تلغي الحجز' });

    const { data, error: updateErr } = await supabase
      .from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id).select().single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ message: 'تم الإلغاء ✅', booking: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── MEDICAL RECORDS ───────────────────────────────────────

app.get('/api/medical-records', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });

    const { data: nurseCheck } = await supabase
      .from('bookings').select('id').eq('user_id', user_id).eq('booking_type', 'nurse').limit(1);
    if (!nurseCheck || nurseCheck.length === 0)
      return res.status(403).json({ error: 'الملفات الطبية للـ nurse بس' });

    const { data, error } = await supabase
      .from('medical_records').select('*').eq('user_id', user_id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    async function makeSignedUrls(jsonStr) {
      if (!jsonStr) return [];
      try {
        const paths = JSON.parse(jsonStr);
        return await Promise.all(paths.map(async (path) => {
          const { data } = await supabase.storage.from('medical-files').createSignedUrl(path, 3600);
          return { path, url: data?.signedUrl };
        }));
      } catch { return []; }
    }

    const result = await Promise.all(data.map(async (r) => ({
      id: r.id, created_at: r.created_at,
      analyses: await makeSignedUrls(r.analyses_urls),
      xrays:    await makeSignedUrls(r.xray_urls),
      others:   await makeSignedUrls(r.other_urls),
    })));

    res.json({ records: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/medical-records/upload', upload.single('file'), async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });
    if (!req.file) return res.status(400).json({ error: 'مفيش ملف' });

    const { data: nurseCheck } = await supabase
      .from('bookings').select('id').eq('user_id', user_id).eq('booking_type', 'nurse').limit(1);
    if (!nurseCheck || nurseCheck.length === 0)
      return res.status(403).json({ error: 'الملفات الطبية للـ nurse بس' });

    const category = req.body.file_category || 'other';
    const ext = req.file.originalname.split('.').pop();
    const filePath = `${user_id}/${category}/${Date.now()}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from('medical-files').upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadErr) return res.status(500).json({ error: 'فشل الرفع: ' + uploadErr.message });

    const colMap = {
      analyses: 'analyses_urls', analysis: 'analyses_urls',
      xray: 'xray_urls', xrays: 'xray_urls', other: 'other_urls',
    };
    const col = colMap[category] || 'other_urls';

    const { data: existing } = await supabase.from('medical_records')
      .select(`id, ${col}`).eq('user_id', user_id).maybeSingle();

    if (existing) {
      const paths = JSON.parse(existing[col] || '[]');
      paths.push(filePath);
      await supabase.from('medical_records').update({ [col]: JSON.stringify(paths) }).eq('id', existing.id);
    } else {
      await supabase.from('medical_records').insert({ user_id, [col]: JSON.stringify([filePath]) });
    }

    res.status(201).json({ message: 'تم الرفع ✅', path: filePath, category });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/medical-records/file', async (req, res) => {
  try {
    const { user_id } = req.query;
    const { file_path, file_category } = req.body;
    if (!user_id || !file_path) return res.status(400).json({ error: 'user_id و file_path مطلوبين' });
    if (!file_path.startsWith(user_id + '/')) return res.status(403).json({ error: 'مش ملفك' });

    await supabase.storage.from('medical-files').remove([file_path]);

    const colMap = {
      analyses: 'analyses_urls', analysis: 'analyses_urls',
      xray: 'xray_urls', xrays: 'xray_urls', other: 'other_urls',
    };
    const col = colMap[file_category] || 'other_urls';

    const { data: record } = await supabase.from('medical_records')
      .select(`id, ${col}`).eq('user_id', user_id).maybeSingle();
    if (record) {
      const paths = JSON.parse(record[col] || '[]').filter(p => p !== file_path);
      await supabase.from('medical_records').update({ [col]: JSON.stringify(paths) }).eq('id', record.id);
    }

    res.json({ message: 'تم الحذف ✅' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DASHBOARD ─────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });

    const [userRes, bookingsRes, medicalRes] = await Promise.all([
      supabase.from('users').select('id, name, role, phone, profile_pic, image_url, created_at, address, bio').eq('id', user_id).single(),
      supabase.from('bookings').select('id, status, total_price, booking_type').eq('user_id', user_id),
      supabase.from('medical_records').select('id').eq('user_id', user_id)
    ]);

    const bookings = bookingsRes.data || [];

    res.json({
      profile: userRes.data,
      stats: {
        total_bookings:      bookings.length,
        completed_bookings:  bookings.filter(b => b.status === 'completed').length,
        pending_bookings:    bookings.filter(b => b.status === 'pending').length,
        cancelled_bookings:  bookings.filter(b => b.status === 'cancelled').length,
        babysitter_bookings: bookings.filter(b => b.booking_type === 'babysitter').length,
        nurse_bookings:      bookings.filter(b => b.booking_type === 'nurse').length,
        total_spending:      bookings.reduce((s, b) => s + Number(b.total_price || 0), 0),
        total_medical_files: medicalRes.data?.length || 0
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PROFILE UPDATE ────────────────────────────────────────

app.patch('/api/profile', async (req, res) => {
  try {
    const { user_id, name, phone, contact_info, image_url, profile_pic, pass, address, bio } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id مطلوب' });

    const updates = {};
    if (name !== undefined)         updates.name = name;
    if (phone !== undefined)        updates.phone = phone;
    if (contact_info !== undefined) updates.contact_info = contact_info;
    if (image_url !== undefined)    updates.image_url = image_url;
    if (profile_pic !== undefined)  updates.profile_pic = profile_pic;
    if (address !== undefined)      updates.address = address;
    if (bio !== undefined)          updates.bio = bio;
    if (pass !== undefined) {
      if (pass.length < 6)
        return res.status(400).json({ error: 'الباسورد لازم يكون 6 حروف على الأقل' });
      updates.pass = pass;
    }

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'مفيش بيانات للتعديل' });

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', user_id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'تم التعديل ✅', user: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));