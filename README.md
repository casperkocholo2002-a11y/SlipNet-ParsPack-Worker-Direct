# SlipNet ParsPack Worker Direct

مسیر مستقل شماره ۲:

User -> Dedicated ParsPack App -> Dedicated Cloudflare Worker -> Internet

این مسیر از سرور 95، دامنه forexcsp و سرور 155 مستقل است.

## ParsPack env

- PUBLIC_RELAY_PATH
- WORKER_HOST
- WORKER_PATH

هر سه مقدار باید فقط متعلق به همین مسیر باشند.

## Worker env

- PUBLIC_PATH
- VLESS_UUIDS

VLESS_UUIDS باید هنگام deploy/مدیریت کاربر تنظیم شود و نباید داخل Git ذخیره شود.

## قوانین جداسازی

- از اپ ParsPack مربوط به 95 استفاده نشود.
- از دامنه forexcsp استفاده نشود.
- Worker hostname و path با مسیرهای دیگر مشترک نباشد.
- اگر Custom Domain به ParsPack وصل می‌شود، برای استقلال فیلترینگ بهتر است root domain آن با مسیرهای دیگر متفاوت باشد.

این مسیر IP خروجی اختصاصی و ثابت تضمین نمی‌کند و برای whitelist آی‌پی ترید، مسیر Fixed-IP مناسب است.
