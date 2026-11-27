-- Creates one database per service (logical database-per-service isolation
-- on a single local Postgres instance). Each service only ever connects to
-- its own database via its own DATABASE_URL.

CREATE DATABASE auth_service;
CREATE DATABASE user_service;
CREATE DATABASE restaurant_service;
CREATE DATABASE menu_service;
CREATE DATABASE order_service;
CREATE DATABASE payment_service;
CREATE DATABASE driver_service;
CREATE DATABASE delivery_service;
CREATE DATABASE notification_service;
CREATE DATABASE audit_service;
