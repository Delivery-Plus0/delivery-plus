import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, UserRole, DriverStatus } from '@food-delivery/shared';
import { DriversService } from '../services/drivers.service';
import { RegisterDriverDto } from '../dto/register-driver.dto';
import { UpdateDriverStatusDto } from '../dto/update-driver-status.dto';
import { ListDriversQueryDto } from '../dto/list-drivers-query.dto';
import { UpdateVehicleDto, UpdateVerificationDto } from '../dto/driver-profile.dto';

@ApiTags('drivers')
@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Post('register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register a driver profile for the current authenticated DRIVER user' })
  register(@CurrentUser() user: JwtPayload, @Body() dto: RegisterDriverDto) {
    return this.driversService.register(user.sub, dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current driver profile' })
  getMe(@CurrentUser() user: JwtPayload) {
    return this.driversService.getByUserId(user.sub);
  }

  @Patch('me/vehicle')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change your vehicle type and plate (#147; only while OFFLINE, 409 otherwise)' })
  updateMyVehicle(@CurrentUser() user: JwtPayload, @Body() dto: UpdateVehicleDto) {
    return this.driversService.updateOwnVehicle(user.sub, dto);
  }

  @Patch(':id/verification')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Set a driver's verification status (ADMIN only, #147)" })
  setVerification(@Param('id') id: string, @Body() dto: UpdateVerificationDto) {
    return this.driversService.setVerification(id, dto);
  }

  @Post('me/online')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Go online (OFFLINE -> AVAILABLE; no-op if already AVAILABLE; 403 while BUSY)' })
  goOnline(@CurrentUser() user: JwtPayload) {
    return this.driversService.updateStatus(user.sub, user.role, { status: DriverStatus.AVAILABLE });
  }

  @Post('me/offline')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Go offline (AVAILABLE -> OFFLINE; no-op if already OFFLINE; 409 while BUSY)' })
  goOffline(@CurrentUser() user: JwtPayload) {
    return this.driversService.updateStatus(user.sub, user.role, { status: DriverStatus.OFFLINE });
  }

  @Post('me/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set driver status explicitly. A DRIVER may only go online/offline; ADMIN any valid transition' })
  setStatus(@CurrentUser() user: JwtPayload, @Body() dto: UpdateDriverStatusDto) {
    return this.driversService.updateStatus(user.sub, user.role, dto);
  }

  @Get('available')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List currently available drivers (admin / delivery-service system token only)' })
  listAvailable(@Query() query: ListDriversQueryDto) {
    return this.driversService.listAvailable(query.page, query.limit);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a driver by id (the driver themself, admin, or a service system token)' })
  getById(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.driversService.getByIdFor(id, user);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin/system: set a specific driver\'s status by id (e.g. delivery-service assigning/releasing a driver)' })
  setStatusById(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateDriverStatusDto) {
    return this.driversService.updateStatusById(id, user.role, dto);
  }
}
