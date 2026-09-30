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
    .select('id, name, teacher_id, is_active, hsk_level')
    .eq('join_code', joinCode.trim().toUpperCase())
    .eq('is_active', true)
    .maybeSingle();

  if (clsErr) throw clsErr;
  if (!cls) throw new Error('Không tìm thấy lớp với mã này. Kiểm tra lại mã lớp giáo viên đã cung cấp.');

  // 1b. options.expectedLevel: học sinh đã BẤM CHỌN một khoá cụ thể (vd HSK2) trên màn "chọn khoá học"
  // trước khi nhập mã -> chặn sớm nếu mã này thực ra thuộc khoá khác, tránh nhầm lẫn.
  if (options.expectedLevel) {
    const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm(cls.hsk_level) !== norm(options.expectedLevel)) {
      throw new Error(`Mã lớp này thuộc ${cls.hsk_level || 'khoá khác'}, không phải ${options.expectedLevel}. Kiểm tra lại mã hoặc quay lại chọn đúng khoá học.`);
    }
  }

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

  // 3. Kiểm tra đã có hồ sơ học sinh gắn với auth_uid này TRONG CHÍNH LỚP NÀY chưa.
  // Lưu ý: một phiên (một thiết bị) giờ có thể có NHIỀU hồ sơ students — mỗi lớp một hồ sơ
  // riêng (vd: 1 hồ sơ ở lớp HSK1, 1 hồ sơ khác ở lớp HSK2) — nên phải lọc thêm theo class_id,
  // không được dùng .maybeSingle() trên riêng auth_uid nữa (sẽ lỗi nếu học sinh đã ở ≥2 lớp).
  const { data: existing } = await sb
    .from('students')
    .select('*')
    .eq('auth_uid', user.id)
    .eq('class_id', cls.id)
    .maybeSingle();

  if (existing) {
    selectStudentClass(existing);
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
    selectStudentClass(relinked);
    return relinked;
  }

  // 4. Chưa từng vào lớp này -> kiểm tra xem đã có ai trùng tên trong lớp chưa (tránh tạo trùng)
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

  // 5. Tạo hồ sơ học sinh mới trong lớp này (auth_uid có thể đã tồn tại ở (các) lớp khác rồi,
  // đó là bình thường — mỗi lớp một hồ sơ riêng, tiến độ không lẫn giữa các lớp)
  const { data: student, error: insErr } = await sb
    .from('students')
    .insert({ class_id: cls.id, auth_uid: user.id, full_name: fullName.trim() })
    .select()
    .single();

  if (insErr) throw insErr;
  selectStudentClass(student);
  return student;
}

// Đánh dấu đây là hồ sơ/lớp đang "hoạt động" cho phiên hiện tại (dùng khi học sinh
// tham gia nhiều lớp và vừa chọn 1 lớp cụ thể để vào học)
function selectStudentClass(student) {
  localStorage.setItem('hy_student_id', student.id);
  localStorage.setItem('hy_class_id', student.class_id);
}

// Trả về TẤT CẢ hồ sơ students (tức tất cả các lớp) gắn với phiên ẩn danh hiện tại,
// kèm thông tin lớp (name, hsk_level). Rỗng nếu chưa từng nhập mã lớp nào.
async function getStudentClasses() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user || !user.is_anonymous) return [];
  const { data, error } = await sb
    .from('students')
    .select('*, classes(name, hsk_level)')
    .eq('auth_uid', user.id)
    .order('created_at', { ascending: true });
  if (error) return [];
  return data || [];
}

// Trả về hồ sơ học sinh đang "hoạt động" cho phiên này:
// - Chưa từng nhập mã lớp nào -> null
// - Có sẵn lựa chọn hợp lệ trong localStorage (hy_student_id khớp 1 trong các lớp) -> dùng lựa chọn đó
// - Chỉ có đúng 1 lớp -> tự động chọn luôn (giữ nguyên trải nghiệm cũ cho học sinh 1 lớp)
// - Có từ 2 lớp trở lên mà CHƯA chọn -> trả về null để nơi gọi biết cần hiển thị màn "chọn lớp"
//   (student-home.html sẽ tự điều hướng sang student-join.html trong trường hợp này)
async function getCurrentStudent() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  // Lớp bảo vệ: phiên KHÔNG ẩn danh (đăng nhập email/mật khẩu = giáo viên) không bao giờ
  // được coi là học sinh, kể cả nếu dữ liệu cũ trong bảng students lỡ bị gán nhầm auth_uid.
  if (!user.is_anonymous) return null;

  const list = await getStudentClasses();
  if (list.length === 0) return null;

  const savedId = localStorage.getItem('hy_student_id');
  const saved = list.find(s => s.id === savedId);
  if (saved) return saved;

  if (list.length === 1) {
    selectStudentClass(list[0]);
    return list[0];
  }

  return null; // nhiều lớp, chưa chọn cái nào -> nơi gọi tự đưa sang màn chọn lớp
}

async function signOutAny() {
  await sb.auth.signOut();
  localStorage.removeItem('hy_student_id');
  localStorage.removeItem('hy_class_id');
}
