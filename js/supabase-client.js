// ============================================================
// SUPABASE CLIENT + HÀM AUTH DÙNG CHUNG
// ============================================================
const { url, anonKey } = window.HY_SUPABASE_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

// ---------- GIÁO VIÊN: email + mật khẩu ----------
async function teacherSignIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function teacherSignUp(email, password, fullName) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { full_name: fullName } }
  });
  if (error) throw error;
  return data;
}

async function getCurrentTeacherProfile() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error) return null;
  return data;
}

// ---------- HỌC SINH: mã lớp + tên (Anonymous Auth) ----------
// options.forceNew = true      -> bỏ qua kiểm tra trùng tên, luôn tạo học sinh mới
// options.relinkStudentId = id -> nối thiết bị này vào ĐÚNG hồ sơ học sinh đã có (xác nhận "đúng là tôi")
async function studentJoinClass(joinCode, fullName, options = {}) {
  // 1. Tìm lớp theo mã
  const { data: cls, error: clsErr } = await sb
    .from('classes')
    .select('id, name, teacher_id, is_active')
    .eq('join_code', joinCode.trim().toUpperCase())
    .eq('is_active', true)
    .maybeSingle();

  if (clsErr) throw clsErr;
  if (!cls) throw new Error('Không tìm thấy lớp với mã này. Kiểm tra lại mã lớp giáo viên đã cung cấp.');

  // 2. Đăng nhập ẩn danh (nếu chưa có phiên)
  // QUAN TRỌNG: nếu thiết bị này đang có sẵn một phiên KHÔNG PHẢI ẩn danh (vd: giáo viên
  // đang đăng nhập email/mật khẩu), TUYỆT ĐỐI không tái sử dụng phiên đó cho học sinh —
  // trước đây lỗi này khiến hồ sơ học sinh bị gán auth_uid = UID của giáo viên, dẫn đến
  // giáo viên tự nhiên "biến thành" học sinh đó mỗi lần đăng nhập. Phải đăng xuất phiên
  // cũ và tạo phiên ẩn danh mới, tách biệt hoàn toàn với mọi phiên giáo viên.
  let { data: { user } } = await sb.auth.getUser();
  if (user && !user.is_anonymous) {
    await sb.auth.signOut();
    user = null;
  }
  if (!user) {
    const { data: anonData, error: anonErr } = await sb.auth.signInAnonymously();
    if (anonErr) throw anonErr;
    user = anonData.user;
  }

  // 3. Kiểm tra đã có hồ sơ học sinh gắn với auth_uid này chưa (đã từng vào lớp trên chính thiết bị này)
  const { data: existing } = await sb
    .from('students')
    .select('*')
    .eq('auth_uid', user.id)
    .maybeSingle();

  if (existing) {
    localStorage.setItem('hy_student_id', existing.id);
    localStorage.setItem('hy_class_id', existing.class_id);
    return existing;
  }

  // 3b. Học sinh vừa xác nhận "đúng là tôi" -> nối thiết bị mới vào hồ sơ cũ, giữ nguyên toàn bộ tiến độ
  if (options.relinkStudentId) {
    const { data: relinked, error: relinkErr } = await sb
      .from('students')
      .update({ auth_uid: user.id, last_active_at: new Date().toISOString() })
      .eq('id', options.relinkStudentId)
      .select()
      .single();
    if (relinkErr) throw relinkErr;
    localStorage.setItem('hy_student_id', relinked.id);
    localStorage.setItem('hy_class_id', relinked.class_id);
    return relinked;
  }

  // 4. Chưa từng vào trên thiết bị này -> kiểm tra xem đã có ai trùng tên trong lớp chưa (tránh tạo trùng)
  if (!options.forceNew) {
    const { data: nameMatches } = await sb
      .from('students')
      .select('id, full_name, class_id')
      .eq('class_id', cls.id)
      .ilike('full_name', fullName.trim());
    if (nameMatches && nameMatches.length > 0) {
      const err = new Error('DUPLICATE_NAME');
      err.code = 'DUPLICATE_NAME';
      err.existingStudent = nameMatches[0];
      throw err;
    }
  }

  // 5. Tạo hồ sơ học sinh mới trong lớp
  const { data: student, error: insErr } = await sb
    .from('students')
    .insert({ class_id: cls.id, auth_uid: user.id, full_name: fullName.trim() })
    .select()
    .single();

  if (insErr) throw insErr;
  localStorage.setItem('hy_student_id', student.id);
  localStorage.setItem('hy_class_id', student.class_id);
  return student;
}

async function getCurrentStudent() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  // Lớp bảo vệ: phiên KHÔNG ẩn danh (đăng nhập email/mật khẩu = giáo viên) không bao giờ
  // được coi là học sinh, kể cả nếu dữ liệu cũ trong bảng students lỡ bị gán nhầm auth_uid.
  if (!user.is_anonymous) return null;
  const { data, error } = await sb.from('students').select('*, classes(name)').eq('auth_uid', user.id).maybeSingle();
  if (error) return null;
  return data;
}

async function signOutAny() {
  await sb.auth.signOut();
  localStorage.removeItem('hy_student_id');
  localStorage.removeItem('hy_class_id');
}
